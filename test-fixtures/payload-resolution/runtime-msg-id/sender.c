/* Ground truth: ipc_send call is UNRESOLVED — payload is a void* with no type info at call site */
#include "types.h"

extern int ipc_send(int sock, int msg_id, void *payload, unsigned int len);

void dispatch_message(int sock, int variable_id, void *payload, unsigned int len)
{
    /* msg_id is a runtime variable, payload is already void* — no type resolution possible */
    ipc_send(sock, variable_id, payload, len);
}
