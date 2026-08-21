#ifndef _SYS_TIME_H
#define _SYS_TIME_H

#include <bits/types.h>

struct timeval {
    __time_t        tv_sec;
    __suseconds_t   tv_usec;
};

struct timespec {
    __time_t        tv_sec;
    long            tv_nsec;
};

typedef struct timeval  timeval;
typedef struct timespec timespec;

#endif
