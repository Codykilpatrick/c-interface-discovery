/*
 * broker_registry.c — Manages client subscription registrations.
 *
 * Listens on BROKER_SUBSCRIBE_PORT for MSG_TYPE_BROKER_SUBSCRIBE messages.
 * Writes accepted registrations into the subscription table in shared memory
 * (BROKER_SUBS_SHM_KEY) so broker_egress can read them without locking.
 *
 * Clients register by sending a BrokerSubscribeMsg specifying the topic
 * (msg_type) they want to receive and the host:port they want deliveries on.
 * The registry responds with MSG_TYPE_BROKER_ACK on success.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/shm.h>
#include <sys/ipc.h>
#include <netinet/in.h>
#include "broker_types.h"

#define BROKER_SUBS_SHM_KEY   0x4253
#define BROKER_SUBS_SHM_SIZE  4096

extern int g_broker_running;

typedef struct {
    unsigned int    topic;
    unsigned int    client_id;
    char            host[48];
    unsigned short  port;
    int             active;
} SubscriberEntry;

typedef struct {
    unsigned int      count;
    SubscriberEntry   subs[BROKER_MAX_SUBSCRIBERS];
} SubscriptionTable;

static int                g_reg_fd   = -1;
static int                g_subs_shm = -1;
static SubscriptionTable *g_subs     = NULL;
static unsigned int       g_next_id  = 1;

static int init_registry_listener(void)
{
    struct sockaddr_in addr;
    int opt = 1;

    g_reg_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (g_reg_fd < 0) return -1;

    setsockopt(g_reg_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port        = htons(BROKER_SUBSCRIBE_PORT);

    if (bind(g_reg_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) return -1;
    return listen(g_reg_fd, 8);
}

static int init_subscription_shm(void)
{
    g_subs_shm = shmget(BROKER_SUBS_SHM_KEY, BROKER_SUBS_SHM_SIZE, IPC_CREAT | 0666);
    if (g_subs_shm < 0) return -1;
    g_subs = (SubscriptionTable *)shmat(g_subs_shm, NULL, 0);
    if (g_subs == (void *)-1) return -1;
    memset(g_subs, 0, sizeof(SubscriptionTable));
    return 0;
}

static void send_ack(int fd, unsigned int topic, unsigned int delivered_seq)
{
    BrokerAckMsg ack;

    ack.header.msg_type    = MSG_TYPE_BROKER_ACK;
    ack.header.seq_num     = delivered_seq;
    ack.header.payload_len = sizeof(BrokerAckMsg);
    ack.header.checksum    = 0;
    ack.topic              = topic;
    ack.delivered_seq      = delivered_seq;
    ack.subscriber_count   = g_subs->count;

    send(fd, &ack, sizeof(BrokerAckMsg), 0);
}

static void handle_subscribe(int fd, const BrokerSubscribeMsg *req)
{
    SubscriberEntry *slot;

    if (g_subs->count >= BROKER_MAX_SUBSCRIBERS) {
        fprintf(stderr, "broker_registry: subscriber table full\n");
        return;
    }

    slot              = &g_subs->subs[g_subs->count++];
    slot->topic       = req->topic;
    slot->client_id   = g_next_id++;
    slot->active      = 1;
    strncpy(slot->host, req->endpoint, sizeof(slot->host) - 1);
    slot->port        = (unsigned short)req->header.seq_num; /* seq_num carries port in subscribe msgs */

    fprintf(stderr, "broker_registry: client %u subscribed to topic 0x%02x at %s:%u\n",
            slot->client_id, slot->topic, slot->host, slot->port);

    send_ack(fd, req->topic, req->header.seq_num);
}

static void handle_client(int fd)
{
    unsigned char buf[sizeof(BrokerSubscribeMsg)];
    int n;

    n = recv(fd, buf, sizeof(buf), 0);
    if (n < (int)sizeof(MsgHeader)) return;

    const MsgHeader *hdr = (const MsgHeader *)buf;

    if (hdr->msg_type == MSG_TYPE_BROKER_SUBSCRIBE &&
        n >= (int)sizeof(BrokerSubscribeMsg)) {
        handle_subscribe(fd, (const BrokerSubscribeMsg *)buf);
    }
}

int broker_registry_main(void)
{
    if (init_registry_listener() != 0) {
        perror("broker_registry: bind");
        return -1;
    }

    if (init_subscription_shm() != 0) {
        perror("broker_registry: shmget");
        return -1;
    }

    while (g_broker_running) {
        int client = accept(g_reg_fd, NULL, NULL);
        if (client < 0) continue;
        handle_client(client);
        close(client);
    }

    shmdt(g_subs);
    shmctl(g_subs_shm, IPC_RMID, NULL);
    close(g_reg_fd);
    return 0;
}
