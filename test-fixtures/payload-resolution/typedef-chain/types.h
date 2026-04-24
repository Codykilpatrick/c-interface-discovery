/* Ground truth: typedef chain resolution
   InnerData → aliased as AliasData → used as field in Wrapper struct
   Layout: Wrapper { AliasData inner; uint32_t id; }
   AliasData/InnerData: { uint16_t x; uint16_t y; } = 4 bytes, align 2
   Wrapper: inner at +0 (4B), id at +4 (4B aligned) = 8 bytes total
*/
typedef struct {
    unsigned short x;
    unsigned short y;
} InnerData;

typedef InnerData AliasData;

typedef struct {
    AliasData inner;
    unsigned int id;
} Wrapper;
