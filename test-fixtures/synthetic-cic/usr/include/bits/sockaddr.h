#ifndef _BITS_SOCKADDR_H
#define _BITS_SOCKADDR_H

#include <bits/types.h>

typedef __sa_family_t sa_family_t;

struct sockaddr {
    sa_family_t     sa_family;
    char            sa_data[14];
};

#endif
