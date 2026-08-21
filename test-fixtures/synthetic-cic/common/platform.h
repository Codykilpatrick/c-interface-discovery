/*
 * platform.h — Build-flag layout of the platform timestamp.
 * Both branches are parsed; the active one is unknown without flags.
 */

#ifndef CIC_PLATFORM_H
#define CIC_PLATFORM_H

#ifdef PLATFORM_64
typedef struct {
    unsigned long long  ts_ns;
    unsigned int        flags;
} PlatformStamp;
#else
typedef struct {
    unsigned int        ts_sec;
    unsigned int        flags;
    unsigned int        pad;
} PlatformStamp;
#endif

#define PLATFORM_STAMP_VALID  0x01
#define PLATFORM_STAMP_STALE  0x02

#endif /* CIC_PLATFORM_H */
