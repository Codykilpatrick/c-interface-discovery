#ifndef _SYS_SOCKET_H
#define _SYS_SOCKET_H

#include <bits/types.h>
#include <bits/sockaddr.h>

typedef __socklen_t socklen_t;

#define AF_INET     2
#define SOCK_STREAM 1
#define SOCK_DGRAM  2
#define SOL_SOCKET  1
#define SO_REUSEADDR 2

int socket(int domain, int type, int protocol);
int bind(int fd, const struct sockaddr *addr, socklen_t len);
int connect(int fd, const struct sockaddr *addr, socklen_t len);
int listen(int fd, int backlog);
int accept(int fd, struct sockaddr *addr, socklen_t *len);
int send(int fd, const void *buf, __size_t n, int flags);
int recv(int fd, void *buf, __size_t n, int flags);

#endif
