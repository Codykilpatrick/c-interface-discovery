/* Ground truth: OwnshipMsg is the payload struct (strategy: address-of via assignment, confidence: high) */
#define OWNSHIP_DATA 0x01

typedef struct {
    float lat;
    float lon;
    float alt;
    float heading;
} OwnshipMsg;
