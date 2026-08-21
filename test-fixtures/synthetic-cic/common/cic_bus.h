/*
 * cic_bus.h — Custom CIC message bus.
 *
 * Import test-fixtures/cid-config.json so cic_bus_send / cic_bus_recv /
 * cic_bus_register / link11_write are treated as IPC, with payload
 * argument indexes for interface-mode resolution.
 */

#ifndef CIC_BUS_H
#define CIC_BUS_H

#include "cic_protocol.h"

typedef struct cic_bus_s * cic_bus_t;
typedef void * cic_passback_t;
typedef void (*cic_bus_cb)(cic_bus_t bus, unsigned int msg_id,
                           unsigned int len, void *data, cic_passback_t pb);

cic_bus_t cic_bus_connect(const char *endpoint);
void      cic_bus_close(cic_bus_t bus);

int cic_bus_send(cic_bus_t bus, unsigned int msg_id,
                 unsigned int size, const void *data);
int cic_bus_recv(cic_bus_t bus, unsigned int *msg_id,
                 unsigned int *size, void *data);
int cic_bus_register(cic_bus_t bus, unsigned int msg_id,
                     cic_bus_cb cb, cic_passback_t pb);

int link11_open(const char *circuit);
int link11_write(int fd, unsigned int pkt_type,
                 const void *data, unsigned int len);

#endif /* CIC_BUS_H */
