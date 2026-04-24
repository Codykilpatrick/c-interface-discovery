/* Ground truth: ipc_send call should resolve to AcousticMsg via pointer-param strategy (HIGH) */
#include "types.h"

extern int ipc_send(int sock, int msg_id, void *payload, unsigned int len);

/* Payload arg is a pointer parameter — strategy B resolves the type directly */
void transmit_acoustic(int sock, AcousticMsg *msg_ptr)
{
    ipc_send(sock, MSG_ACOUSTIC, msg_ptr, sizeof(AcousticMsg));
}
