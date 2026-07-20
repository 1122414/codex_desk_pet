Import("env")

from pathlib import Path

framework = Path(env.PioPlatform().get_package_dir("framework-arduinoespressif32"))
env.Append(CPPPATH=[
    str(framework / "libraries" / "WiFi" / "src"),
    str(framework / "libraries" / "WiFiClientSecure" / "src"),
])
