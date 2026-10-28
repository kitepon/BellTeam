# mach_continuous_time

出典: https://developer.apple.com/documentation/kernel/1646199-mach_continuous_time
取得日: 2026-10-29。確度: Apple公式のAPI説明。

> Returns current value of a clock that increments monotonically in tick units (starting at an arbitrary point), including while the system is asleep.

同じ説明は、ナノ秒単位では`clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)`を使うよう案内する。
