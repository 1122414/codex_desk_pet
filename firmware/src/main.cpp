#include "firmware_app.hpp"

codex::firmware::FirmwareApp app;

void setup() {
  app.setup();
}

void loop() {
  app.loop();
}
