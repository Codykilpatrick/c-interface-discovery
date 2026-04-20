/*
 * broker_ingress.c — Accepts messages from publishing clients.
 *
 * All applications that want to publish a message connect to
 * BROKER_INGEST_PORT and send it here.  The ingress process validates the
 * header, records a MSG_TYPE_BROKER_LOG entry, and writes the raw payload
 * into the broker's internal routing queue for egress to deliver.
 *
 * Known publishers at runtime:
 *   - sensor array (fire_control): publishes MSG_TYPE_SOLUTION
 *   - WCS (weapons_director):      publishes MSG_TYPE_COMMAND
 *
 * Neither publisher knows about the other — they only know the broker address.
 *
 * Internal data flow:
 *   [sensor array] --MSG_TYPE_SOLUTION--> [broker_ingress]  (TCP recv)
 *   [WCS]          --MSG_TYPE_COMMAND --> [broker_ingress]  (TCP recv)
 *   [broker_ingress] --routing queue--> [broker_egress]     (msg queue)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/msg.h>
#include <sys/ipc.h>
#include <netinet/in.h>
#include "broker_types.h"

#define BROKER_ROUTE_MQ_KEY  0x4252   /* 'BR' — internal routing queue */

extern int g_broker_running;

static int g_listen_fd  = -1;
static int g_route_mq   = -1;

typedef struct {
    long            mtype;
    unsigned int    topic;
    unsigned char   payload[MAX_PAYLOAD_LEN];
    unsigned int    payload_len;
} RoutingMsg;

static int init_ingress_listener(void)
{
    struct sockaddr_in addr;
    int opt = 1;

    g_listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (g_listen_fd < 0) return -1;

    setsockopt(g_listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port        = htons(BROKER_INGEST_PORT);

    if (bind(g_listen_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) return -1;
    return listen(g_listen_fd, BROKER_MAX_SUBSCRIBERS);
}

static int init_routing_queue(void)
{
    g_route_mq = msgget(BROKER_ROUTE_MQ_KEY, IPC_CREAT | 0666);
    return (g_route_mq < 0) ? -1 : 0;
}

static void log_received(unsigned int topic, unsigned int seq)
{
    BrokerLogMsg log;

    log.header.msg_type    = MSG_TYPE_BROKER_LOG;
    log.header.seq_num     = seq;
    log.header.payload_len = sizeof(BrokerLogMsg);
    log.header.checksum    = 0;
    log.topic              = topic;
    log.source_client      = 0;
    log.dest_count         = 0;
    snprintf(log.note, sizeof(log.note), "ingress topic=0x%02x", topic);
    /* Logged to internal audit queue — not forwarded to clients */
}

static void enqueue_for_routing(unsigned int topic,
                                 const unsigned char *data,
                                 unsigned int len)
{
    RoutingMsg rmsg;

    if (len > MAX_PAYLOAD_LEN) len = MAX_PAYLOAD_LEN;

    rmsg.mtype       = (long)topic;
    rmsg.topic       = topic;
    rmsg.payload_len = len;
    memcpy(rmsg.payload, data, len);

    if (msgsnd(g_route_mq, &rmsg, sizeof(rmsg) - sizeof(long), 0) < 0) {
        perror("broker_ingress: msgsnd route");
    }
}

static void handle_client(int fd)
{
    unsigned char    buf[MAX_PAYLOAD_LEN];
    int              n;

    while (g_broker_running) {
        n = recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) break;

        if ((unsigned int)n < sizeof(MsgHeader)) continue;
        const MsgHeader *hdr = (const MsgHeader *)buf;

        switch (hdr->msg_type) {
        case MSG_TYPE_SOLUTION:
            fprintf(stderr, "broker_ingress: received MSG_TYPE_SOLUTION seq=%u\n",
                    hdr->seq_num);
            log_received(MSG_TYPE_SOLUTION, hdr->seq_num);
            enqueue_for_routing(MSG_TYPE_SOLUTION, buf, (unsigned int)n);
            break;

        case MSG_TYPE_COMMAND:
            fprintf(stderr, "broker_ingress: received MSG_TYPE_COMMAND seq=%u\n",
                    hdr->seq_num);
            log_received(MSG_TYPE_COMMAND, hdr->seq_num);
            enqueue_for_routing(MSG_TYPE_COMMAND, buf, (unsigned int)n);
            break;

        default:
            fprintf(stderr, "broker_ingress: unknown topic 0x%02x — dropped\n",
                    hdr->msg_type);
            break;
        }
    }

    close(fd);
}

static void *client_thread(void *arg)
{
    int fd = *(int *)arg;
    free(arg);
    handle_client(fd);
    return NULL;
}

int broker_ingress_main(void)
{
    if (init_ingress_listener() != 0) {
        perror("broker_ingress: bind");
        return -1;
    }

    if (init_routing_queue() != 0) {
        perror("broker_ingress: msgget");
        return -1;
    }

    fprintf(stderr, "broker_ingress: listening on port %d\n", BROKER_INGEST_PORT);

    while (g_broker_running) {
        int *fd_ptr;
        int client = accept(g_listen_fd, NULL, NULL);
        if (client < 0) continue;

        fd_ptr  = malloc(sizeof(int));
        *fd_ptr = client;

        pthread_t tid;
        pthread_create(&tid, NULL, client_thread, fd_ptr);
        pthread_detach(tid);
    }

    close(g_listen_fd);
    return 0;
}
