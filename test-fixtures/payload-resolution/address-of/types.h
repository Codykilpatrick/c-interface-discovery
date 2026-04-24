/* Ground truth: NavMsg is the payload struct for MSG_NAV (strategy: address-of, confidence: high) */
#define MSG_NAV 0x01
#define MSG_STATUS 0x02

typedef struct {
    float lat;
    float lon;
    float alt;
    uint32_t timestamp;
} NavMsg;

typedef struct {
    uint8_t code;
    char text[32];
} StatusMsg;
