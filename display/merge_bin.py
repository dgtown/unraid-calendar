# After a build, write <build>/calendar-display-factory.bin: bootloader + partitions + app in one
# file that can be flashed at offset 0x0 from a browser (https://espressif.github.io/esptool-js/).
import os

Import("env")  # noqa: F821  (provided by PlatformIO)


def merge_bin(source, target, env):
    out = os.path.join(env.subst("$BUILD_DIR"), "calendar-display-factory.bin")
    images = []
    for offset, image in env.get("FLASH_EXTRA_IMAGES", []):
        images += [offset, '"%s"' % env.subst(image)]
    images += [env.subst("$ESP32_APP_OFFSET"), '"%s"' % str(target[0])]
    env.Execute(" ".join([
        '"$PYTHONEXE"', '"$OBJCOPY"', "--chip", "esp32", "merge_bin", "-o", '"%s"' % out,
        "--flash_mode", "dio", "--flash_size", "4MB", *images,
    ]))


env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", merge_bin)  # noqa: F821
