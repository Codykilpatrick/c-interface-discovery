/*
 * bits/types.h — glibc-style internal typedefs.
 * Drop usr/include/ into External Includes with common/.
 */

#ifndef _BITS_TYPES_H
#define _BITS_TYPES_H

typedef unsigned char   __uint8_t;
typedef unsigned short  __uint16_t;
typedef unsigned int    __uint32_t;
typedef signed int      __int32_t;
typedef unsigned long   __uint64_t;

typedef long            __time_t;
typedef long            __suseconds_t;
typedef unsigned int    __socklen_t;
typedef unsigned short  __sa_family_t;
typedef unsigned int    __be32;
typedef unsigned short  __be16;
typedef long            __off_t;
typedef int             __pid_t;
typedef unsigned long   __size_t;
typedef long            __ssize_t;

#endif
