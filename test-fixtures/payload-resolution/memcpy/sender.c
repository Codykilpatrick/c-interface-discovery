/* Ground truth: ipc_send call resolves to SonarMsg via memcpy strategy (MEDIUM) */
#include "types.h"
#include <string.h>

extern int ipc_send(int sock, int msg_id, void *payload, unsigned int len);

void send_sonar_contact(int sock, SonarMsg *contact)
{
    unsigned char outbuf[64];
    /* memcpy from &src → outbuf before send — strategy traces the source type */
    memcpy(outbuf, contact, sizeof(SonarMsg));
    ipc_send(sock, MSG_SONAR, outbuf, sizeof(SonarMsg));
}
