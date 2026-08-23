/**
 * Hand-built TypeDict mirroring `test-fixtures/synthetic-cic/`.
 *
 * Transcribed from the protocol headers so role, padding and composition tests
 * run offline without tree-sitter WASM. Where the fixture deliberately defines a
 * struct twice to exercise conflict handling (`TrackMsg`, `PlatformStamp`), the
 * canonical `common/` protocol definition is used — conflict resolution is the
 * file registry's job and is covered by its own tests.
 *
 * Array lengths are kept in their real macro form (`tracks[CIC_MAX_TRACKS]`)
 * rather than substituted, because that is what the parser actually sees and it
 * is what triggers the variable-length-array warning.
 */

import type { CStruct, MessageInterface, TypeDict } from '../../types';

function st(name: string, sourceFile: string, fields: [string, string][]): CStruct {
  return {
    name,
    sourceFile,
    conditional: false,
    fields: fields.map(([type, fname]) => ({ type, name: fname })),
  };
}

const PROTO = 'common/cic_protocol.h';

export function cicTypeDict(): TypeDict {
  return {
    enums: [],
    defines: [],
    typedefAliases: {
      // System header chains — several hops deep, which is the point.
      __time_t: 'long',
      __suseconds_t: 'long',
      __be32: 'unsigned int',
      __be16: 'unsigned short',
      __sa_family_t: 'unsigned short',
      time_t: '__time_t',
      suseconds_t: '__suseconds_t',
      sa_family_t: '__sa_family_t',
      in_port_t: '__be16',
      // Application aliases.
      DepthFixAlias: 'DepthFix',
      NavFixAlias: 'GpsFix',
    },
    structs: [
      // ── system types (fake usr/include tree) ──
      st('timeval', 'usr/include/sys/time.h', [
        ['__time_t', 'tv_sec'],
        ['__suseconds_t', 'tv_usec'],
      ]),
      st('in_addr', 'usr/include/netinet/in.h', [['__be32', 's_addr']]),
      st('sockaddr_in', 'usr/include/netinet/in.h', [
        ['sa_family_t', 'sin_family'],
        ['in_port_t', 'sin_port'],
        ['struct in_addr', 'sin_addr'],
        ['char', 'sin_zero[8]'],
      ]),

      // ── the six-level nest ──
      st('CicTime', 'common/time_stamp.h', [
        ['timeval', 'wall'],
        ['unsigned int', 'nsec'],
      ]),
      st('GeoCoord', 'common/geo_coord.h', [
        ['CicTime', 'when'],
        ['float', 'lat'],
        ['float', 'lon'],
      ]),
      st('DepthFix', 'common/depth_fix.h', [
        ['GeoCoord', 'horiz'],
        ['float', 'depth'],
      ]),
      st('MotionState', 'common/motion.h', [
        ['DepthFixAlias', 'pos'],
        ['float', 'heading'],
        ['float', 'speed_kt'],
      ]),
      st('TrackKinematics', 'common/track_kinematics.h', [
        ['MotionState', 'motion'],
        ['int', 'vx'],
        ['int', 'vy'],
        ['float', 'snr'],
      ]),
      st('FusedContact', 'common/fused_contact.h', [
        ['TrackKinematics', 'kin'],
        ['unsigned int', 'sensor_id'],
        ['char', 'label[32]'],
      ]),

      // ── envelope + messages ──
      st('CicHeader', PROTO, [
        ['unsigned short', 'msg_type'],
        ['unsigned short', 'length'],
        ['unsigned int', 'seq'],
        ['unsigned char', 'checksum'],
      ]),
      st('ContactMsg', PROTO, [
        ['CicHeader', 'hdr'],
        ['FusedContact', 'body'],
        ['struct sockaddr_in', 'origin'],
      ]),
      st('OwnShipMsg', PROTO, [
        ['CicHeader', 'hdr'],
        ['MotionState', 'motion'],
        ['unsigned int', 'fix_quality'],
      ]),
      st('TrackMsg', PROTO, [
        ['CicHeader', 'hdr'],
        ['unsigned int', 'track_id'],
        ['TrackKinematics', 'kin'],
        ['unsigned int', 'source'],
      ]),
      st('EngageMsg', PROTO, [
        ['CicHeader', 'hdr'],
        ['unsigned int', 'track_id'],
        ['unsigned int', 'weapon_id'],
        ['unsigned int', 'auth_flags'],
        ['TrackKinematics', 'aim'],
      ]),
      st('WeaponOrdMsg', PROTO, [
        ['CicHeader', 'hdr'],
        ['unsigned int', 'tube_id'],
        ['unsigned int', 'track_id'],
        ['unsigned int', 'weapon_type'],
      ]),
      st('LinkReportPkt', PROTO, [
        ['CicHeader', 'hdr'],
        ['unsigned int', 'n_tracks'],
        ['unsigned int', 'own_ship_seq'],
        ['char', 'note[64]'],
      ]),
      st('HeartbeatMsg', PROTO, [
        ['CicHeader', 'hdr'],
        ['unsigned int', 'origin'],
      ]),

      // ── per-app types ──
      st('PictureTable', 'cic/cic_types.h', [
        ['unsigned int', 'count'],
        ['TrackMsg', 'tracks[CIC_MAX_TRACKS]'],
      ]),
      st('GpsFix', 'nav/nav_types.h', [
        ['DepthFix', 'fix'],
        ['unsigned int', 'sats'],
      ]),
      st('NavFixMsg', 'nav/nav_types.h', [
        ['CicHeader', 'hdr'],
        ['NavFixAlias', 'body'],
        ['unsigned int', 'source'],
      ]),
      st('AimSolution', 'firecontrol/fc_types.h', [
        ['TrackKinematics', 'kin'],
        ['unsigned int', 'tube_id'],
        ['float', 'time_to_impact'],
      ]),
      st('FireDirective', 'firecontrol/fc_types.h', [
        ['EngageMsg', 'order'],
        ['AimSolution', 'aim'],
      ]),
      st('BeamBuffer', 'sonar/sonar_types.h', [
        ['unsigned int', 'beam_id'],
        ['short', 'samples[256]'],
        ['unsigned int', 'n_samples'],
        ['float', 'peak'],
      ]),
      st('PlatformStamp', 'sonar/platform.h', [
        ['unsigned int', 'ts_ms'],
        ['unsigned short', 'flags'],
      ]),
      st('SonarFrame', 'sonar/sonar_types.h', [
        ['PlatformStamp', 'stamp'],
        ['BeamBuffer', 'beams[SONAR_MAX_BEAMS]'],
        ['unsigned int', 'n_beams'],
      ]),
      st('SonarContact', 'sonar/sonar_types.h', [
        ['FusedContact', 'fused'],
        ['unsigned int', 'beam_id'],
        ['float', 'peak'],
      ]),
    ],
  };
}

/** The 8 message constants the fixture documents, with their resolved structs. */
export const CIC_MESSAGES: [string, string, string][] = [
  ['MSG_TYPE_CONTACT', '0x30', 'ContactMsg'],
  ['MSG_TYPE_OWN_SHIP', '0x31', 'OwnShipMsg'],
  ['MSG_TYPE_TRACK', '0x32', 'TrackMsg'],
  ['MSG_TYPE_ENGAGE', '0x33', 'EngageMsg'],
  ['MSG_TYPE_WEAPON_ORD', '0x34', 'WeaponOrdMsg'],
  ['MSG_TYPE_HEARTBEAT', '0x35', 'HeartbeatMsg'],
  ['MSG_ID_NAV_FIX', '0x40', 'NavFixMsg'],
  ['PKT_TYPE_LINK_REPORT', '0x50', 'LinkReportPkt'],
];

export function cicMessageInterfaces(dict: TypeDict): MessageInterface[] {
  return CIC_MESSAGES.map(([constant, value, structName]) => {
    const struct = dict.structs.find((s) => s.name === structName) ?? null;
    return {
      msgTypeConstant: constant,
      msgTypeValue: value,
      struct,
      structResolved: struct !== null,
      direction: 'producer' as const,
      directionConfident: true,
      transport: 'custom' as const,
      definedIn: PROTO,
      usedIn: [],
      fileRoles: [],
    };
  });
}

/**
 * Structs referenced from `.c` sources. `FireDirective` and `SonarContact` are
 * defined in headers but never used in the fixture's source — the orphan case.
 */
export function cicReferencedInSource(): Set<string> {
  return new Set([
    'ContactMsg', 'OwnShipMsg', 'TrackMsg', 'EngageMsg', 'WeaponOrdMsg',
    'LinkReportPkt', 'HeartbeatMsg', 'NavFixMsg', 'CicHeader', 'FusedContact',
    'TrackKinematics', 'MotionState', 'DepthFix', 'GeoCoord', 'CicTime',
    'timeval', 'sockaddr_in', 'in_addr', 'GpsFix', 'PictureTable',
    'SonarFrame', 'BeamBuffer', 'PlatformStamp', 'AimSolution',
  ]);
}
