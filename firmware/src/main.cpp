#include "firmware_app.hpp"

SET_LOOP_TASK_STACK_SIZE(32 * 1024);

codex::firmware::FirmwareApp app;

void setup() {
  app.setup();
}

void loop() {
  app.loop();
}
