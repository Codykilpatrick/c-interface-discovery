#ifndef CIC_TIME_STAMP_H
#define CIC_TIME_STAMP_H

#include <sys/time.h>

/*
 * Layer 1 — wraps the system timeval from usr/include/sys/time.h.
 * Nested by GeoCoord. Layout has to chase timeval → __time_t / __suseconds_t
 * from bits/types.h.
 */
typedef struct {
    timeval         wall;
    unsigned int    nsec;
} CicTime;

#endif
