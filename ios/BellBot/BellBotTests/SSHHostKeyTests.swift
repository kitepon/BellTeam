import CryptoKit
import Foundation
import XCTest
@testable import BellBot

/// apple/terminals.md S2: SSH wire encoding, the exchange hash and signature on a recorded OpenSSH_10.5 handshake, and this Mac's addresses.
final class SSHHostKeyTests: XCTestCase {
    private typealias V = SSHHostKeyVector

    private func exchange(replacing reply: Data? = nil, serverBanner: String? = nil) throws -> SSHHostKey.Exchange {
        SSHHostKey.Exchange(
            clientBanner: V.data(V.clientBanner), serverBanner: serverBanner.map { Data($0.utf8) } ?? V.data(V.serverBanner),
            clientKexInit: V.data(V.clientKexInit), serverKexInit: V.data(V.serverKexInit),
            ephemeral: try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: V.data(V.ephemeralPrivateKey)),
            reply: reply ?? V.data(V.reply))
    }

    func testWireEncodesStringsAndMpints() {
        XCTAssertEqual(SSHWire.uint32(0x01020304), Data([1, 2, 3, 4]))
        XCTAssertEqual(SSHWire.string("abc"), Data([0, 0, 0, 3, 0x61, 0x62, 0x63]))
        XCTAssertEqual(SSHWire.string(""), Data([0, 0, 0, 0]))
        // RFC 4251 section 5 examples.
        XCTAssertEqual(SSHWire.mpint(Data()), Data([0, 0, 0, 0]))
        XCTAssertEqual(SSHWire.mpint(Data([0x00, 0x00])), Data([0, 0, 0, 0]), "zero has no bytes")
        XCTAssertEqual(SSHWire.mpint(Data([0x9a, 0x37, 0x8f, 0x9b, 0x2e, 0x33, 0x2a, 0x7a])),
                       Data([0, 0, 0, 9, 0, 0x9a, 0x37, 0x8f, 0x9b, 0x2e, 0x33, 0x2a, 0x7a]), "top bit set: a zero byte first")
        XCTAssertEqual(SSHWire.mpint(Data([0x00, 0x00, 0x7f, 0x01])), Data([0, 0, 0, 2, 0x7f, 0x01]), "leading zeros dropped")
    }

    func testPacketRoundTripsWithValidPadding() throws {
        for size in [0, 1, 2, 3, 7, 8, 9, 100] {
            let payload = Data((0..<size).map { UInt8($0 & 0xff) })
            let packet = SSHWire.packet(payload)
            XCTAssertEqual(packet.count % 8, 0, "payload \(size)")
            let length = packet.prefix(4).reduce(0) { $0 << 8 | Int($1) }
            XCTAssertEqual(length, packet.count - 4)
            XCTAssertGreaterThanOrEqual(Int(packet[4]), 4, "padding is at least 4")
            XCTAssertEqual(try SSHWire.payload(ofPacketBody: Data(packet.dropFirst(4))), payload)
        }
        XCTAssertThrowsError(try SSHWire.payload(ofPacketBody: Data([2, 1, 2])))
        XCTAssertThrowsError(try SSHWire.payload(ofPacketBody: Data()))
    }

    func testReaderReadsFieldsAndRefusesShortData() throws {
        var reader = SSHWire.Reader(SSHWire.string("a,b") + SSHWire.string("") + SSHWire.uint32(7) + Data([9]))
        XCTAssertEqual(try reader.nameList(), ["a", "b"])
        XCTAssertEqual(try reader.nameList(), [])
        XCTAssertEqual(try reader.uint32(), 7)
        XCTAssertEqual(try reader.byte(), 9)
        XCTAssertThrowsError(try reader.byte())
        var short = SSHWire.Reader(Data([0, 0, 0, 5, 1]))
        XCTAssertThrowsError(try short.string())
    }

    func testClientKexInitOffersOnlyEd25519AndCurve25519() throws {
        let init_ = SSHHostKey.clientKexInit(cookie: Data(repeating: 7, count: 16))
        XCTAssertEqual(init_.first, 20)
        let parsed = try SSHHostKey.ServerKexInit(payload: init_)
        XCTAssertEqual(parsed.kexAlgorithms, ["curve25519-sha256", "curve25519-sha256@libssh.org"])
        XCTAssertEqual(parsed.hostKeyAlgorithms, ["ssh-ed25519"])
        XCTAssertFalse(parsed.firstKexPacketFollows)
        XCTAssertEqual(try parsed.negotiate(), "curve25519-sha256")
    }

    func testRecordedServerOffersWhatTheClientNeeds() throws {
        let server = try SSHHostKey.ServerKexInit(payload: V.data(V.serverKexInit))
        XCTAssertEqual(try server.negotiate(), "curve25519-sha256")
        XCTAssertTrue(server.hostKeyAlgorithms.contains("ssh-ed25519"))
    }

    func testNegotiationNamesWhatIsMissing() throws {
        func server(kex: String, hostKeys: String, guess: UInt8 = 0) throws -> SSHHostKey.ServerKexInit {
            var payload = Data([20]) + Data(repeating: 0, count: 16) + SSHWire.string(kex) + SSHWire.string(hostKeys)
            for _ in 0..<8 { payload.append(SSHWire.string("x")) }
            return try SSHHostKey.ServerKexInit(payload: payload + Data([guess]) + SSHWire.uint32(0))
        }
        XCTAssertThrowsError(try server(kex: "curve25519-sha256", hostKeys: "ssh-rsa,rsa-sha2-512").negotiate()) {
            XCTAssertEqual($0 as? SSHHostKeyError, .unsupported("this sshd offers no ssh-ed25519 host key"))
        }
        XCTAssertThrowsError(try server(kex: "diffie-hellman-group14-sha256", hostKeys: "ssh-ed25519").negotiate())
        XCTAssertEqual(try server(kex: "curve25519-sha256@libssh.org", hostKeys: "ssh-ed25519").negotiate(), "curve25519-sha256@libssh.org")
        XCTAssertThrowsError(try server(kex: "curve25519-sha256", hostKeys: "ssh-ed25519", guess: 1).negotiate())
    }

    func testEcdhInitCarriesTheEphemeralPublicKey() throws {
        let key = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: V.data(V.ephemeralPrivateKey))
        let payload = SSHHostKey.ecdhInit(publicKey: key.publicKey)
        XCTAssertEqual(payload.first, 30)
        var reader = SSHWire.Reader(payload.dropFirst())
        XCTAssertEqual(try reader.string(), key.publicKey.rawRepresentation)
    }

    func testRecordedHandshakeVerifiesAndGivesTheSshKeygenFingerprint() throws {
        // `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the recorded Mac printed this same value.
        XCTAssertEqual(try SSHHostKey.fingerprint(try exchange()), V.fingerprint)
        let reply = try SSHHostKey.Reply(payload: V.data(V.reply))
        XCTAssertEqual(reply.serverEphemeral.count, 32)
        XCTAssertEqual(SSHHostKey.format(hostKey: reply.hostKey), V.fingerprint)
    }

    func testFingerprintHasTheSha256FormTheServerChecks() throws {
        let value = try SSHHostKey.fingerprint(try exchange())
        XCTAssertTrue(value.hasPrefix("SHA256:"))
        XCTAssertEqual(value.count, 7 + 43)
        XCTAssertFalse(value.contains("="))
        XCTAssertNil(HostKeyFingerprint.problem(value))
    }

    func testABadSignatureOrAnAlteredExchangeGivesNoFingerprint() throws {
        var forged = V.data(V.reply)
        forged[forged.count - 1] ^= 0x01 // the last signature byte
        XCTAssertThrowsError(try SSHHostKey.fingerprint(try exchange(replacing: forged))) { XCTAssertEqual($0 as? SSHHostKeyError, .badSignature) }
        // The hash covers V_S: another banner means another H, so the same signature no longer verifies.
        XCTAssertThrowsError(try SSHHostKey.fingerprint(try exchange(serverBanner: "SSH-2.0-OpenSSH_9.9"))) { XCTAssertEqual($0 as? SSHHostKeyError, .badSignature) }
        // A host key swapped for another one (a machine that only copied the signature) fails the same way.
        let other = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let reply = try SSHHostKey.Reply(payload: V.data(V.reply))
        let swapped = Data([31]) + SSHWire.string(SSHWire.string("ssh-ed25519") + SSHWire.string(other))
            + SSHWire.string(reply.serverEphemeral) + SSHWire.string(reply.signature)
        XCTAssertThrowsError(try SSHHostKey.fingerprint(try exchange(replacing: swapped))) { XCTAssertEqual($0 as? SSHHostKeyError, .badSignature) }
    }

    func testOtherHostKeyTypesAndBrokenRepliesAreTypedErrors() throws {
        let reply = try SSHHostKey.Reply(payload: V.data(V.reply))
        let rsa = Data([31]) + SSHWire.string(SSHWire.string("ssh-rsa") + SSHWire.string(Data(repeating: 1, count: 32)))
            + SSHWire.string(reply.serverEphemeral) + SSHWire.string(reply.signature)
        XCTAssertThrowsError(try SSHHostKey.fingerprint(try exchange(replacing: rsa))) {
            XCTAssertEqual($0 as? SSHHostKeyError, .unsupported("the host key is not ssh-ed25519"))
        }
        XCTAssertThrowsError(try SSHHostKey.fingerprint(try exchange(replacing: Data([31, 0, 0])))) { XCTAssertTrue($0 is SSHHostKeyError) }
        XCTAssertThrowsError(try SSHHostKey.fingerprint(try exchange(replacing: Data([32]) + V.data(V.reply).dropFirst())))
        XCTAssertThrowsError(try SSHHostKey.fingerprint(try exchange(replacing: Data([31]) + SSHWire.string(reply.hostKey) + SSHWire.string(Data(count: 5)) + SSHWire.string(reply.signature))))
    }

    // MARK: This Mac's addresses (S1, and which terminals the Mac app may attest)

    private let interfaces = [
        ThisMac.Interface(name: "lo0", address: "127.0.0.1", isIPv6: false),
        ThisMac.Interface(name: "lo0", address: "::1", isIPv6: true),
        ThisMac.Interface(name: "en5", address: "169.254.10.2", isIPv6: false),
        ThisMac.Interface(name: "en5", address: "10.0.0.9", isIPv6: false),
        ThisMac.Interface(name: "en0", address: "192.168.1.101", isIPv6: false),
        ThisMac.Interface(name: "en0", address: "2400:2412:d24a:d000:865:3c6e:9cdb:3317", isIPv6: true),
        ThisMac.Interface(name: "en0", address: "fe80::8fa:3d67:2339:77c8", isIPv6: true),
    ]

    func testPrimaryIPv4PrefersEn0AndSkipsLoopbackAndLinkLocal() {
        XCTAssertEqual(ThisMac.primaryIPv4(interfaces), "192.168.1.101")
        XCTAssertEqual(ThisMac.primaryIPv4(Array(interfaces.prefix(4))), "10.0.0.9", "en0 が無ければ最初の使える IPv4")
        XCTAssertNil(ThisMac.primaryIPv4(Array(interfaces.prefix(3))))
        XCTAssertNil(ThisMac.primaryIPv4([]))
    }

    func testOwnsMatchesOnlyThisMacsAddressesAndNames() {
        func owns(_ host: String) -> Bool { ThisMac.owns(host: host, interfaces: interfaces, hostName: "MacBook-Air.local") }
        for host in ["192.168.1.101", "127.0.0.1", "::1", "localhost", "LOCALHOST", "10.0.0.9", "fe80::8fa:3d67:2339:77c8%en0",
                     "2400:2412:d24a:d000:0865:3c6e:9cdb:3317", "macbook-air.local", "MacBook-Air", "macbook-air.local"] {
            XCTAssertTrue(owns(host), host)
        }
        for host in ["192.168.1.102", "office-imac.local", "studio-mac", "", "192.168.1", "fe80::1", "example.com", "macbook-air.example.com"] {
            XCTAssertFalse(owns(host), host)
        }
        XCTAssertFalse(ThisMac.owns(host: "macbook-air.local", interfaces: interfaces, hostName: nil), "ホスト名が読めなければ名前では一致させない")
    }
}
