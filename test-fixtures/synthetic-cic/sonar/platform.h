/*
 * Local sonar override of PlatformStamp — different fields than
 * common/platform.h. Loading sonar/ plus common/ as external includes
 * should flag a struct conflict on PlatformStamp.
 */

#ifndef CIC_PLATFORM_H
#define CIC_PLATFORM_H

typedef struct {
    unsigned int    ts_ms;
    unsigned short  flags;
} PlatformStamp;

#endif /* CIC_PLATFORM_H */
