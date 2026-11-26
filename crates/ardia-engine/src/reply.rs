use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};

use futures::channel::oneshot;
use parking_lot::Mutex;

use crate::error::{EngineError, EngineResult};

#[must_use = "a Reply does nothing unless awaited or polled"]
pub struct Reply<T> {
    state: State<T>,
    registration: Option<(&'static PendingRequests, u64)>,
}

enum State<T> {
    Ready(Option<EngineResult<T>>),
    Waiting(oneshot::Receiver<EngineResult<T>>),
}

impl<T> Reply<T> {
    pub fn ready(result: EngineResult<T>) -> Self {
        Self {
            state: State::Ready(Some(result)),
            registration: None,
        }
    }

    pub fn ok(value: T) -> Self {
        Self::ready(Ok(value))
    }

    pub fn err(error: EngineError) -> Self {
        Self::ready(Err(error))
    }

    pub fn channel() -> (Responder<T>, Self) {
        let (sender, receiver) = oneshot::channel();
        (
            Responder { sender },
            Self {
                state: State::Waiting(receiver),
                registration: None,
            },
        )
    }

    fn settled(&mut self) {
        self.state = State::Ready(None);
        self.registration = None;
    }

    pub fn try_take(&mut self) -> Option<EngineResult<T>> {
        match &mut self.state {
            State::Ready(result) => result.take(),
            State::Waiting(receiver) => match receiver.try_recv() {
                Ok(Some(result)) => {
                    self.settled();
                    Some(result)
                }
                Ok(None) => None,
                Err(oneshot::Canceled) => {
                    self.settled();
                    Some(Err(EngineError::Cancelled))
                }
            },
        }
    }
}

impl<T> Drop for Reply<T> {
    fn drop(&mut self) {
        if let (State::Waiting(_), Some((registry, id))) = (&self.state, self.registration.take()) {
            registry.withdraw(id);
        }
    }
}

impl<T> Unpin for Reply<T> {}

impl<T> Future for Reply<T> {
    type Output = EngineResult<T>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match &mut self.state {
            State::Ready(result) => {
                Poll::Ready(result.take().unwrap_or(Err(EngineError::Cancelled)))
            }
            State::Waiting(receiver) => match Pin::new(receiver).poll(cx) {
                Poll::Ready(outcome) => {
                    self.settled();
                    Poll::Ready(outcome.unwrap_or(Err(EngineError::Cancelled)))
                }
                Poll::Pending => Poll::Pending,
            },
        }
    }
}

impl<T> std::fmt::Debug for Reply<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self.state {
            State::Ready(Some(_)) => "Reply(ready)",
            State::Ready(None) => "Reply(taken)",
            State::Waiting(_) => "Reply(waiting)",
        })
    }
}

pub struct Responder<T> {
    sender: oneshot::Sender<EngineResult<T>>,
}

impl<T> Responder<T> {
    pub fn send(self, result: EngineResult<T>) {
        let _ = self.sender.send(result);
    }

    pub fn is_wanted(&self) -> bool {
        !self.sender.is_canceled()
    }
}

#[derive(Default, PartialEq, Eq)]
pub struct Completion {
    pub status: CompletionStatus,
    pub json: Option<String>,
    pub bytes: Option<Vec<u8>>,
}

impl std::fmt::Debug for Completion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Completion")
            .field("status", &self.status)
            .field("json", &self.json.as_ref().map(String::len))
            .field("bytes", &self.bytes.as_ref().map(Vec::len))
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CompletionStatus {
    #[default]
    Ok,
    Error,
    Cancelled,
}

impl CompletionStatus {
    pub fn from_raw(raw: i32) -> Self {
        match raw {
            0 => Self::Ok,
            2 => Self::Cancelled,
            _ => Self::Error,
        }
    }
}

impl Completion {
    pub fn into_json(self) -> EngineResult<serde_json::Value> {
        match self.status {
            CompletionStatus::Cancelled => Err(EngineError::Cancelled),
            CompletionStatus::Error => Err(EngineError::Failed(
                self.json
                    .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                    .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned))
                    .unwrap_or_else(|| "the engine reported a failure".into()),
            )),
            CompletionStatus::Ok => match self.json {
                None => Ok(serde_json::Value::Null),
                Some(json) => {
                    serde_json::from_str(&json).map_err(|e| EngineError::BadReply(e.to_string()))
                }
            },
        }
    }
}

type Waiter = Box<dyn FnOnce(Completion) + Send>;

pub struct PendingRequests {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, Waiter>>,
}

impl Default for PendingRequests {
    fn default() -> Self {
        Self::new()
    }
}

impl PendingRequests {
    pub fn new() -> Self {
        Self {
            next: AtomicU64::new(1),
            waiting: Mutex::new(HashMap::new()),
        }
    }

    pub fn register(&self, waiter: impl FnOnce(Completion) + Send + 'static) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.waiting.lock().insert(id, Box::new(waiter));
        id
    }

    pub fn register_reply<T: Send + 'static>(
        &'static self,
        decode: impl FnOnce(Completion) -> EngineResult<T> + Send + 'static,
    ) -> (u64, Reply<T>) {
        let (responder, mut reply) = Reply::channel();
        let id = self.register(move |completion| responder.send(decode(completion)));
        reply.registration = Some((self, id));
        (id, reply)
    }

    pub fn complete(&self, id: u64, completion: Completion) -> bool {
        self.complete_with(id, || completion)
    }

    pub fn complete_with(&self, id: u64, completion: impl FnOnce() -> Completion) -> bool {
        let waiter = self.waiting.lock().remove(&id);
        match waiter {
            Some(waiter) => {
                waiter(completion());
                true
            }
            None => false,
        }
    }

    pub fn cancel(&self, id: u64) -> bool {
        self.complete(
            id,
            Completion {
                status: CompletionStatus::Cancelled,
                ..Completion::default()
            },
        )
    }

    pub fn withdraw(&self, id: u64) -> bool {
        self.waiting.lock().remove(&id).is_some()
    }

    pub fn cancel_all(&self) -> usize {
        let drained: Vec<Waiter> = self
            .waiting
            .lock()
            .drain()
            .map(|(_, waiter)| waiter)
            .collect();
        let count = drained.len();
        for waiter in drained {
            waiter(Completion {
                status: CompletionStatus::Cancelled,
                ..Completion::default()
            });
        }
        count
    }

    pub fn len(&self) -> usize {
        self.waiting.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::executor::block_on;
    use serde_json::json;

    #[test]
    fn ready_replies_resolve_once() {
        let mut reply = Reply::ok(5);
        assert_eq!(reply.try_take(), Some(Ok(5)));
        assert_eq!(reply.try_take(), None);
        assert_eq!(
            block_on(Reply::<i32>::err(EngineError::NotStarted)),
            Err(EngineError::NotStarted)
        );
    }

    #[test]
    fn dropped_responder_cancels() {
        let (responder, reply) = Reply::<i32>::channel();
        drop(responder);
        assert_eq!(block_on(reply), Err(EngineError::Cancelled));
    }

    fn registry() -> &'static PendingRequests {
        Box::leak(Box::new(PendingRequests::new()))
    }

    #[test]
    fn dropping_a_waiting_reply_withdraws_it() {
        let pending = registry();
        let (id, reply) = pending.register_reply(Completion::into_json);
        assert_eq!(pending.len(), 1);
        drop(reply);
        assert!(pending.is_empty());
        assert!(!pending.complete(id, Completion::default()));
        let (_, mut answered) = pending.register_reply(Completion::into_json);
        pending.cancel_all();
        assert_eq!(answered.try_take(), Some(Err(EngineError::Cancelled)));
        drop(answered);
        assert!(pending.is_empty());
    }

    #[test]
    fn pending_requests_complete_exactly_once() {
        let pending = registry();
        let (id, mut reply) = pending.register_reply(Completion::into_json);
        assert_eq!(reply.try_take(), None);
        assert!(pending.complete(
            id,
            Completion {
                json: Some("{\"a\":1}".into()),
                ..Completion::default()
            }
        ));
        assert!(!pending.complete(id, Completion::default()));
        assert_eq!(reply.try_take(), Some(Ok(json!({"a": 1}))));
        assert!(pending.is_empty());
    }

    #[test]
    fn cancel_all_resolves_every_waiter() {
        let pending = registry();
        let replies: Vec<_> = (0..3)
            .map(|_| pending.register_reply(Completion::into_json).1)
            .collect();
        assert_eq!(pending.cancel_all(), 3);
        for reply in replies {
            assert_eq!(block_on(reply), Err(EngineError::Cancelled));
        }
    }

    #[test]
    fn completion_errors_carry_the_engine_message() {
        let failed = Completion {
            status: CompletionStatus::Error,
            json: Some("{\"error\":\"no tab\"}".into()),
            bytes: None,
        };
        assert_eq!(
            failed.into_json(),
            Err(EngineError::Failed("no tab".into()))
        );
        let garbage = Completion {
            json: Some("{".into()),
            ..Completion::default()
        };
        assert!(matches!(garbage.into_json(), Err(EngineError::BadReply(_))));
        assert_eq!(CompletionStatus::from_raw(2), CompletionStatus::Cancelled);
        assert_eq!(CompletionStatus::from_raw(9), CompletionStatus::Error);
    }

    #[test]
    fn waiters_can_reenter_the_registry() {
        let pending = std::sync::Arc::new(PendingRequests::new());
        let inner = pending.clone();
        let id = pending.register(move |_| {
            inner.register(|_| {});
        });
        assert!(pending.complete(id, Completion::default()));
        assert_eq!(pending.len(), 1);
    }
}
