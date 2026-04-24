/* Ground truth: nested struct layout
   Header:     { uint16_t msg_type; uint16_t length; }  = 4 bytes, align 2
   NavPayload: { float lat; float lon; }                = 8 bytes, align 4
   NavPacket:  { Header hdr; NavPayload nav; uint32_t crc; }
               hdr at +0 (4B), nav at +4 (4B aligned), crc at +12 (4B aligned) = 16 bytes total
*/
typedef struct {
    unsigned short msg_type;
    unsigned short length;
} Header;

typedef struct {
    float lat;
    float lon;
} NavPayload;

typedef struct {
    Header hdr;
    NavPayload nav;
    unsigned int crc;
} NavPacket;
