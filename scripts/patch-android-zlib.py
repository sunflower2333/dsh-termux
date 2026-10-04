#!/usr/bin/env python3
"""Make Node's bundled zlib use NDK-supported Android CPU feature APIs."""

from pathlib import Path
import sys


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch-android-zlib.py <cpu_features.c>")
    path = Path(sys.argv[1])
    source = path.read_text()
    old_include = "#if defined(ARMV8_OS_ANDROID)\n#include <cpu-features.h>\n#elif defined(ARMV8_OS_LINUX)"
    new_include = "#if defined(ARMV8_OS_ANDROID)\n#include <asm/hwcap.h>\n#include <sys/auxv.h>\n#elif defined(ARMV8_OS_LINUX)"
    old_features = """#if defined(ARMV8_OS_ANDROID) && defined(__aarch64__)
    uint64_t features = android_getCpuFeatures();
    arm_cpu_enable_crc32 = !!(features & ANDROID_CPU_ARM64_FEATURE_CRC32);
    arm_cpu_enable_pmull = !!(features & ANDROID_CPU_ARM64_FEATURE_PMULL);"""
    new_features = """#if defined(ARMV8_OS_ANDROID) && defined(__aarch64__)
    unsigned long features = getauxval(AT_HWCAP);
    arm_cpu_enable_crc32 = !!(features & HWCAP_CRC32);
    arm_cpu_enable_pmull = !!(features & HWCAP_PMULL);"""
    if old_include in source:
        source = source.replace(old_include, new_include, 1)
    elif new_include not in source:
        raise SystemExit("zlib Android CPU feature include marker not found")
    if old_features in source:
        source = source.replace(old_features, new_features, 1)
    elif new_features not in source:
        raise SystemExit("zlib Android CPU feature marker not found")
    path.write_text(source)


if __name__ == "__main__":
    main()
