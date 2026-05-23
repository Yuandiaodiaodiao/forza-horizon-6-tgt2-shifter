/**
 * Forza Horizon 6 Telemetry — UDP receiver and parser
 *
 * Packet: 324 bytes, little-endian binary
 * Sled (232 bytes) + 12 bytes padding + Dash (80 bytes)
 * Dash starts at offset 244: pos_x/y/z, speed, power, torque, tire_temps, ...
 */
import { createSocket } from "node:dgram";

const DASH_OFF = 244; // 232 sled + 12 padding
const G = 9.80665;

const CAR_CLASS: Record<number, string> = { 0:"D", 1:"C", 2:"B", 3:"A", 4:"S1", 5:"S2", 6:"X" };
const DRIVETRAIN: Record<number, string> = { 0:"FWD", 1:"RWD", 2:"AWD" };

function parseTelemetry(buf: Buffer): Record<string, any> | null {
  if (buf.length < 232) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.getInt32(0, true) === 0) return null;

  const f = (off: number) => v.getFloat32(off, true);
  const i32 = (off: number) => v.getInt32(off, true);

  const accelX = f(20), accelY = f(24), accelZ = f(28);

  const result: Record<string, any> = {
    type: "telemetry",
    ts: Date.now() / 1000,
    rpm: Math.round(f(16)),
    max_rpm: Math.round(f(8)),
    idle_rpm: Math.round(f(12)),
    g_lat: Math.round(accelX / G * 100) / 100,
    g_lon: Math.round(accelZ / G * 100) / 100,
    g_vert: Math.round(accelY / G * 100) / 100,
    vel_x: Math.round(f(32) * 100) / 100,
    vel_y: Math.round(f(36) * 100) / 100,
    vel_z: Math.round(f(40) * 100) / 100,
    ang_vel_x: Math.round(f(44) * 1000) / 1000,
    ang_vel_y: Math.round(f(48) * 1000) / 1000,
    ang_vel_z: Math.round(f(52) * 1000) / 1000,
    yaw: Math.round(f(56) * 1000) / 1000,
    pitch: Math.round(f(60) * 1000) / 1000,
    roll: Math.round(f(64) * 1000) / 1000,
    susp_travel: [f(68), f(72), f(76), f(80)].map(v => Math.round(v * 1000) / 1000),
    slip_ratio: [f(84), f(88), f(92), f(96)].map(v => Math.round(v * 1000) / 1000),
    wheel_speed: [f(100), f(104), f(108), f(112)].map(v => Math.round(v * 10) / 10),
    rumble_strip: [f(116), f(120), f(124), f(128)].map(v => Math.round(v * 100) / 100),
    puddle_depth: [f(132), f(136), f(140), f(144)].map(v => Math.round(v * 100) / 100),
    slip_angle: [f(164), f(168), f(172), f(176)].map(v => Math.round(v * 1000) / 1000),
    tire_slip: [f(180), f(184), f(188), f(192)].map(v => Math.round(v * 1000) / 1000),
    susp_travel_m: [f(196), f(200), f(204), f(208)].map(v => Math.round(v * 10000) / 10000),
    car_ordinal: i32(212),
    car_class: CAR_CLASS[i32(216)] ?? "?",
    car_pi: i32(220),
    drivetrain: DRIVETRAIN[i32(224)] ?? "?",
    num_cylinders: i32(228),
  };

  if (buf.length >= DASH_OFF + 80) {
    const d = DASH_OFF;
    result.pos_x = Math.round(f(d) * 10) / 10;
    result.pos_y = Math.round(f(d + 4) * 10) / 10;
    result.pos_z = Math.round(f(d + 8) * 10) / 10;
    const speedMs = f(d + 12);
    result.speed_kmh = Math.round(speedMs * 3.6 * 10) / 10;
    result.speed_mph = Math.round(speedMs * 2.237 * 10) / 10;
    result.power_hp = Math.round(f(d + 16) / 745.7 * 10) / 10;
    result.torque_nm = Math.round(f(d + 20) * 10) / 10;
    result.tire_temp = [f(d+24), f(d+28), f(d+32), f(d+36)].map(v => Math.round(v*10)/10);
    result.boost = Math.round(f(d + 40) * 100) / 100;
    result.fuel = Math.round(f(d + 44) * 100) / 100;
    result.distance = Math.round(f(d + 48) * 10) / 10;
    result.best_lap = Math.round(f(d + 52) * 1000) / 1000;
    result.last_lap = Math.round(f(d + 56) * 1000) / 1000;
    result.current_lap = Math.round(f(d + 60) * 1000) / 1000;
    result.current_race_time = Math.round(f(d + 64) * 1000) / 1000;
    result.lap_number = v.getUint16(d + 68, true);
    result.race_position = v.getUint8(d + 70);
    result.accel = v.getUint8(d + 71);
    result.brake = v.getUint8(d + 72);
    result.clutch = v.getUint8(d + 73);
    result.handbrake = v.getUint8(d + 74);
    result.gear = v.getUint8(d + 75);
    result.steer = v.getInt8(d + 76);
  }

  return result;
}

export class ForzaReceiver {
  private pktCount = 0;

  constructor(port: number, _hz: number, private onEvent: (evt: Record<string, any>) => void) {
    const sock = createSocket("udp4");
    sock.on("message", (msg) => this.handlePacket(msg));
    sock.bind(port, "0.0.0.0");
  }

  private handlePacket(msg: Buffer) {
    const pkt = parseTelemetry(msg);
    if (!pkt) return;

    this.pktCount++;
    // The aggregation/distribution layer owns output frequency and latest-frame
    // replacement. Capture never creates a second backlog here.
    this.onEvent(pkt);

    if (this.pktCount % 300 === 1) {
      const g = pkt.gear;
      const gs = g === 0 ? "R" : g === 11 ? "N" : String(g);
      console.log(
        `  ${(pkt.speed_kmh ?? 0).toFixed(1).padStart(6)} km/h | ` +
        `RPM ${String(pkt.rpm).padStart(5)}/${pkt.max_rpm} | ` +
        `Gear ${gs} | Power ${(pkt.power_hp ?? 0).toFixed(1).padStart(6)} HP | ` +
        `Lap ${pkt.lap_number ?? 0}`
      );
    }
  }
}
