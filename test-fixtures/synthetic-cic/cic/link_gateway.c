/*
 * link_gateway.c — Tactical data link egress.
 *
 * Packs a LinkReportPkt and writes it with link11_write (custom pattern).
 * PKT_TYPE_LINK_REPORT has no consumer in this suite — incomplete outbound.
 * Also receives MSG_TYPE_ENGAGE from fire control and logs it.
 */

#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include "cic_types.h"

extern int g_cic_running;

static int       g_link_fd = -1;
static int       g_listen  = -1;
static cic_bus_t g_bus     = NULL;

static int init_engage_listener(void)
{
    struct sockaddr_in addr;
    int opt = 1;

    g_listen = socket(AF_INET, SOCK_STREAM, 0);
    if (g_listen < 0) return -1;
    setsockopt(g_listen, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port        = htons(CIC_ENGAGE_PORT);
    if (bind(g_listen, (struct sockaddr *)&addr, sizeof(addr)) < 0) return -1;
    return listen(g_listen, 4);
}

static void publish_link_report(unsigned int n_tracks)
{
    LinkReportPkt pkt;

    memset(&pkt, 0, sizeof(pkt));
    pkt.hdr.msg_type = PKT_TYPE_LINK_REPORT;
    pkt.hdr.length   = sizeof(LinkReportPkt);
    pkt.n_tracks     = n_tracks;
    strcpy(pkt.note, "cic-link");

    link11_write(g_link_fd, PKT_TYPE_LINK_REPORT, &pkt, sizeof(pkt));
}

int link_gateway_main(void)
{
    unsigned char buf[sizeof(EngageMsg)];
    int fd, n;

    g_bus = cic_bus_connect(CIC_BUS_ENDPOINT);
    if (!g_bus) return -1;
    g_link_fd = link11_open("link11://circuit-a");
    if (g_link_fd < 0) return -1;
    if (init_engage_listener() != 0) return -1;

    while (g_cic_running) {
        publish_link_report(4);

        fd = accept(g_listen, NULL, NULL);
        if (fd < 0) continue;
        n = recv(fd, buf, sizeof(buf), 0);
        if (n >= (int)sizeof(CicHeader)) {
            const CicHeader *hdr = (const CicHeader *)buf;
            if (hdr->msg_type == MSG_TYPE_ENGAGE)
                fprintf(stderr, "link_gateway: engage received\n");
        }
        close(fd);
        usleep(500000);
    }

    cic_bus_close(g_bus);
    close(g_listen);
    close(g_link_fd);
    return 0;
}
