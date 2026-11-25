#pragma once

#import <Foundation/Foundation.h>

namespace ardia_native_messaging {

void SyncHosts(NSString *userDataDir);

NSArray<NSDictionary<NSString *, id> *> *HostReports();

}
