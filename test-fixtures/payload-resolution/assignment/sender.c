/* Ground truth: send_message resolves to OwnshipMsg via prior-assignment strategy (HIGH)
   msgID/msgSize/msgData are set in prior statements, not inline at the call site. */
#include "types.h"

typedef unsigned short MESSAGE_ID;
typedef unsigned int   MESSAGE_LENGTH;
typedef void *         MESSAGE_POINTER;

extern int send_message(void *handle, MESSAGE_ID id, MESSAGE_LENGTH len, MESSAGE_POINTER data);

void publish_ownship(void *pb, float lat, float lon, float alt, float hdg)
{
    OwnshipMsg msg;
    MESSAGE_ID     msgID;
    MESSAGE_LENGTH msgSize;
    MESSAGE_POINTER msgData;

    msg.lat     = lat;
    msg.lon     = lon;
    msg.alt     = alt;
    msg.heading = hdg;

    msgID   = OWNSHIP_DATA;
    msgSize = sizeof(OwnshipMsg);
    msgData = &msg;

    send_message(pb, msgID, msgSize, msgData);
}
