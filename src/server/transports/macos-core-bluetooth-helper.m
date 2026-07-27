#import <CoreBluetooth/CoreBluetooth.h>
#import <Foundation/Foundation.h>

static CBUUID *ServiceUUID(void) {
  return [CBUUID UUIDWithString:@"7C4B1000-8F3A-4D6B-9C2E-4F5A6B7C8D90"];
}

static CBUUID *ReceiveUUID(void) {
  return [CBUUID UUIDWithString:@"7C4B1001-8F3A-4D6B-9C2E-4F5A6B7C8D90"];
}

static CBUUID *TransmitUUID(void) {
  return [CBUUID UUIDWithString:@"7C4B1002-8F3A-4D6B-9C2E-4F5A6B7C8D90"];
}

static void Emit(NSDictionary<NSString *, id> *payload) {
  if (![NSJSONSerialization isValidJSONObject:payload]) return;
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
  if (data == nil || error != nil) return;
  NSMutableData *line = [data mutableCopy];
  const uint8_t newline = '\n';
  [line appendBytes:&newline length:1];
  [[NSFileHandle fileHandleWithStandardOutput] writeData:line];
}

@interface CodexBluetoothBridge : NSObject <CBCentralManagerDelegate, CBPeripheralDelegate>
@property(nonatomic, strong) CBCentralManager *central;
@property(nonatomic, strong, nullable) CBPeripheral *peripheral;
@property(nonatomic, strong, nullable) CBCharacteristic *receiveCharacteristic;
@property(nonatomic, strong, nullable) CBCharacteristic *transmitCharacteristic;
@property(nonatomic, strong) NSMutableArray<NSData *> *pendingWrites;
@property(nonatomic, strong) NSMutableData *inputBuffer;
@property(nonatomic) BOOL writeInFlight;
@property(nonatomic) BOOL shuttingDown;
@end

@implementation CodexBluetoothBridge

- (instancetype)init {
  self = [super init];
  if (self == nil) return nil;
  _pendingWrites = [NSMutableArray array];
  _inputBuffer = [NSMutableData data];
  _central = [[CBCentralManager alloc] initWithDelegate:self
                                                  queue:dispatch_get_main_queue()];
  __weak CodexBluetoothBridge *weakSelf = self;
  [NSFileHandle fileHandleWithStandardInput].readabilityHandler =
      ^(NSFileHandle *handle) {
        NSData *data = handle.availableData;
        dispatch_async(dispatch_get_main_queue(), ^{
          [weakSelf acceptInput:data];
        });
      };
  return self;
}

- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
  NSString *state = @"unknown";
  switch (central.state) {
    case CBManagerStatePoweredOn:
      state = @"poweredOn";
      break;
    case CBManagerStatePoweredOff:
      state = @"poweredOff";
      break;
    case CBManagerStateUnauthorized:
      state = @"unauthorized";
      break;
    case CBManagerStateUnsupported:
      state = @"unsupported";
      break;
    case CBManagerStateResetting:
      state = @"resetting";
      break;
    case CBManagerStateUnknown:
      break;
  }
  Emit(@{@"type" : @"state", @"state" : state});
  if (central.state == CBManagerStatePoweredOn) [self startScanning];
}

- (void)centralManager:(CBCentralManager *)central
    didDiscoverPeripheral:(CBPeripheral *)peripheral
        advertisementData:(NSDictionary<NSString *, id> *)advertisementData
                     RSSI:(NSNumber *)RSSI {
  if (self.peripheral != nil || self.shuttingDown) return;
  self.peripheral = peripheral;
  peripheral.delegate = self;
  [central stopScan];
  Emit(@{
    @"type" : @"discovered",
    @"id" : peripheral.identifier.UUIDString,
    @"name" : peripheral.name ?: @"Codex Pet",
    @"rssi" : RSSI,
  });
  [central connectPeripheral:peripheral
                     options:@{CBConnectPeripheralOptionNotifyOnDisconnectionKey : @YES}];
}

- (void)centralManager:(CBCentralManager *)central
    didConnectPeripheral:(CBPeripheral *)peripheral {
  [peripheral discoverServices:@[ ServiceUUID() ]];
}

- (void)centralManager:(CBCentralManager *)central
    didFailToConnectPeripheral:(CBPeripheral *)peripheral
                         error:(NSError *)error {
  Emit(@{
    @"type" : @"diagnostic",
    @"message" : [NSString
        stringWithFormat:@"BLE connection failed: %@",
                         error.localizedDescription ?: @"unknown error"],
  });
  [self resetConnection];
}

- (void)centralManager:(CBCentralManager *)central
    didDisconnectPeripheral:(CBPeripheral *)peripheral
                      error:(NSError *)error {
  Emit(@{
    @"type" : @"disconnected",
    @"id" : peripheral.identifier.UUIDString,
    @"reason" : error.localizedDescription ?: @"disconnected",
  });
  [self resetConnection];
}

- (void)peripheral:(CBPeripheral *)peripheral
    didDiscoverServices:(NSError *)error {
  if (error != nil) {
    [self failConnection:[NSString
                             stringWithFormat:@"BLE service discovery failed: %@",
                                              error.localizedDescription]];
    return;
  }
  CBService *target = nil;
  for (CBService *service in peripheral.services) {
    if ([service.UUID isEqual:ServiceUUID()]) {
      target = service;
      break;
    }
  }
  if (target == nil) {
    [self failConnection:@"Codex Pet BLE service is missing"];
    return;
  }
  [peripheral discoverCharacteristics:@[ ReceiveUUID(), TransmitUUID() ]
                            forService:target];
}

- (void)peripheral:(CBPeripheral *)peripheral
    didDiscoverCharacteristicsForService:(CBService *)service
                                   error:(NSError *)error {
  if (error != nil) {
    [self failConnection:[NSString
                             stringWithFormat:@"BLE characteristic discovery failed: %@",
                                              error.localizedDescription]];
    return;
  }
  for (CBCharacteristic *characteristic in service.characteristics) {
    if ([characteristic.UUID isEqual:ReceiveUUID()]) {
      self.receiveCharacteristic = characteristic;
    } else if ([characteristic.UUID isEqual:TransmitUUID()]) {
      self.transmitCharacteristic = characteristic;
    }
  }
  if (self.receiveCharacteristic == nil || self.transmitCharacteristic == nil) {
    [self failConnection:@"Codex Pet BLE characteristics are incomplete"];
    return;
  }
  [peripheral setNotifyValue:YES forCharacteristic:self.transmitCharacteristic];
}

- (void)peripheral:(CBPeripheral *)peripheral
    didUpdateNotificationStateForCharacteristic:(CBCharacteristic *)characteristic
                                          error:(NSError *)error {
  if (error != nil) {
    [self failConnection:[NSString
                             stringWithFormat:@"BLE notification setup failed: %@",
                                              error.localizedDescription]];
    return;
  }
  if (![characteristic.UUID isEqual:TransmitUUID()] || !characteristic.isNotifying) return;
  Emit(@{
    @"type" : @"connected",
    @"id" : peripheral.identifier.UUIDString,
    @"name" : peripheral.name ?: @"Codex Pet",
    @"maximumWriteBytes" :
        @([peripheral maximumWriteValueLengthForType:CBCharacteristicWriteWithResponse]),
  });
  [self pumpWrites];
}

- (void)peripheral:(CBPeripheral *)peripheral
    didUpdateValueForCharacteristic:(CBCharacteristic *)characteristic
                              error:(NSError *)error {
  if (error != nil) {
    Emit(@{
      @"type" : @"diagnostic",
      @"message" : [NSString
          stringWithFormat:@"BLE notification failed: %@", error.localizedDescription],
    });
    return;
  }
  if (![characteristic.UUID isEqual:TransmitUUID()] || characteristic.value == nil) return;
  Emit(@{
    @"type" : @"fragment",
    @"data" : [characteristic.value base64EncodedStringWithOptions:0],
  });
}

- (void)peripheral:(CBPeripheral *)peripheral
    didWriteValueForCharacteristic:(CBCharacteristic *)characteristic
                             error:(NSError *)error {
  self.writeInFlight = NO;
  if (error != nil) {
    Emit(@{
      @"type" : @"diagnostic",
      @"message" :
          [NSString stringWithFormat:@"BLE write failed: %@", error.localizedDescription],
    });
  }
  [self pumpWrites];
}

- (void)startScanning {
  if (self.central.state != CBManagerStatePoweredOn ||
      self.peripheral != nil ||
      self.shuttingDown) {
    return;
  }
  [self.central scanForPeripheralsWithServices:@[ ServiceUUID() ]
                                      options:@{CBCentralManagerScanOptionAllowDuplicatesKey : @NO}];
}

- (void)acceptInput:(NSData *)data {
  if (data.length == 0) {
    [self shutdown];
    return;
  }
  [self.inputBuffer appendData:data];
  while (true) {
    const void *bytes = self.inputBuffer.bytes;
    const void *newline = memchr(bytes, '\n', self.inputBuffer.length);
    if (newline == NULL) return;
    const NSUInteger lineLength =
        (const uint8_t *)newline - (const uint8_t *)bytes;
    NSData *line = [self.inputBuffer subdataWithRange:NSMakeRange(0, lineLength)];
    [self.inputBuffer
        replaceBytesInRange:NSMakeRange(0, lineLength + 1)
                  withBytes:NULL
                     length:0];
    if (line.length == 0) continue;
    NSError *error = nil;
    NSDictionary<NSString *, id> *value =
        [NSJSONSerialization JSONObjectWithData:line options:0 error:&error];
    NSString *type = [value isKindOfClass:NSDictionary.class] ? value[@"type"] : nil;
    if (![type isKindOfClass:NSString.class]) continue;
    if ([type isEqualToString:@"write"]) {
      NSString *encoded = value[@"data"];
      NSData *fragment = [encoded isKindOfClass:NSString.class]
          ? [[NSData alloc] initWithBase64EncodedString:encoded options:0]
          : nil;
      if (fragment.length == 0 || fragment.length > 512) {
        Emit(@{@"type" : @"diagnostic", @"message" : @"BLE write payload is invalid"});
        continue;
      }
      [self.pendingWrites addObject:fragment];
      [self pumpWrites];
    } else if ([type isEqualToString:@"disconnect"]) {
      if (self.peripheral != nil) {
        [self.central cancelPeripheralConnection:self.peripheral];
      }
    } else if ([type isEqualToString:@"close"]) {
      [self shutdown];
    }
  }
}

- (void)pumpWrites {
  if (self.writeInFlight ||
      self.pendingWrites.count == 0 ||
      self.peripheral.state != CBPeripheralStateConnected ||
      self.receiveCharacteristic == nil) {
    return;
  }
  NSData *fragment = self.pendingWrites.firstObject;
  [self.pendingWrites removeObjectAtIndex:0];
  const NSUInteger maximum =
      [self.peripheral maximumWriteValueLengthForType:CBCharacteristicWriteWithResponse];
  if (fragment.length > maximum) {
    Emit(@{
      @"type" : @"diagnostic",
      @"message" : @"BLE fragment exceeds negotiated write size",
    });
    [self pumpWrites];
    return;
  }
  self.writeInFlight = YES;
  [self.peripheral writeValue:fragment
            forCharacteristic:self.receiveCharacteristic
                         type:CBCharacteristicWriteWithResponse];
}

- (void)failConnection:(NSString *)message {
  Emit(@{@"type" : @"diagnostic", @"message" : message});
  if (self.peripheral != nil) {
    [self.central cancelPeripheralConnection:self.peripheral];
  } else {
    [self resetConnection];
  }
}

- (void)resetConnection {
  self.peripheral = nil;
  self.receiveCharacteristic = nil;
  self.transmitCharacteristic = nil;
  [self.pendingWrites removeAllObjects];
  self.writeInFlight = NO;
  if (self.shuttingDown) return;
  dispatch_after(
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC)),
      dispatch_get_main_queue(),
      ^{
        [self startScanning];
      });
}

- (void)shutdown {
  if (self.shuttingDown) return;
  self.shuttingDown = YES;
  [NSFileHandle fileHandleWithStandardInput].readabilityHandler = nil;
  [self.central stopScan];
  if (self.peripheral != nil) {
    [self.central cancelPeripheralConnection:self.peripheral];
  }
  Emit(@{@"type" : @"closed"});
  fflush(stdout);
  exit(EXIT_SUCCESS);
}

@end

int main(void) {
  @autoreleasepool {
    CodexBluetoothBridge *bridge = [[CodexBluetoothBridge alloc] init];
    if (bridge == nil) return EXIT_FAILURE;
    [[NSRunLoop mainRunLoop] run];
  }
  return EXIT_SUCCESS;
}
