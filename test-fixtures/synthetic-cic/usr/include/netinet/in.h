#ifndef _NETINET_IN_H
#define _NETINET_IN_H

#include <bits/types.h>
#include <bits/sockaddr.h>
#include <sys/socket.h>

typedef __uint16_t in_port_t;
typedef __uint32_t in_addr_t;

struct in_addr {
    __be32          s_addr;
};

struct sockaddr_in {
    sa_family_t     sin_family;
    in_port_t       sin_port;
    struct in_addr  sin_addr;
    char            sin_zero[8];
};

#define INADDR_ANY  ((in_addr_t)0)

#endif
