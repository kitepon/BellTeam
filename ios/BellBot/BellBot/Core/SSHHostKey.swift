import CryptoKit
import Foundation

// F-SEAT-HOST S2 (docs/architecture/modules/apple/terminals.md): the host-key fingerprint of this Mac, read from its own sshd by a
// key exchange that is stopped after SSH_MSG_KEX_ECDH_REPLY (no NEWKEYS, no authentication). RFC 4253 / 5656 / 8731.

enum SSHHostKeyError: Error, Equatable {
    case malformed(String)
    case unsupported(String)
    case badSignature
    case connection(String)
}

/// SSH wire encoding (RFC 4251 section 5) and the unencrypted binary packet (RFC 4253 section 6).
enum SSHWire {
    static func uint32(_ value: Int) -> Data { withUnsafeBytes(of: UInt32(value).bigEndian) { Data($0) } }

    static func string(_ bytes: Data) -> Data { uint32(bytes.count) + bytes }
    static func string(_ text: String) -> Data { string(Data(text.utf8)) }

    /// A big-endian unsigned integer as mpint: no leading zeros, a zero byte first when the top bit is set.
    static func mpint(_ bigEndian: Data) -> Data {
        let trimmed = bigEndian.drop(while: { $0 == 0 })
        if let first = trimmed.first, first & 0x80 != 0 { return string(Data([0]) + trimmed) }
        return string(Data(trimmed))
    }

    /// padding >= 4 and the whole packet a multiple of 8 (no cipher yet).
    static func packet(_ payload: Data, padding: Data? = nil) -> Data {
        var padLength = 8 - (5 + payload.count) % 8
        if padLength < 4 { padLength += 8 }
        let pad = padding ?? Data((0..<padLength).map { _ in UInt8.random(in: 0...255) })
        return uint32(1 + payload.count + pad.count) + Data([UInt8(pad.count)]) + payload + pad
    }

    /// The payload of one unencrypted packet whose length prefix and body are already split.
    static func payload(ofPacketBody body: Data) throws -> Data {
        guard let padLength = body.first.map(Int.init), padLength >= 4, body.count >= 1 + padLength else {
            throw SSHHostKeyError.malformed("packet padding")
        }
        return Data(body.dropFirst().dropLast(padLength))
    }

    struct Reader {
        private let data: Data
        private var offset: Int
        init(_ data: Data) { self.data = data; offset = data.startIndex }
        var remaining: Int { data.endIndex - offset }

        mutating func byte() throws -> UInt8 {
            guard remaining >= 1 else { throw SSHHostKeyError.malformed("short read") }
            defer { offset += 1 }
            return data[offset]
        }
        mutating func bytes(_ count: Int) throws -> Data {
            guard count >= 0, remaining >= count else { throw SSHHostKeyError.malformed("short read") }
            defer { offset += count }
            return Data(data[offset..<offset + count])
        }
        mutating func uint32() throws -> Int { try bytes(4).reduce(0) { $0 << 8 | Int($1) } }
        mutating func string() throws -> Data { try bytes(try uint32()) }
        mutating func nameList() throws -> [String] {
            let text = String(decoding: try string(), as: UTF8.self)
            return text.isEmpty ? [] : text.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
        }
    }
}

enum SSHHostKey {
    static let kexMessageInit: UInt8 = 20
    static let ecdhInit: UInt8 = 30
    static let ecdhReply: UInt8 = 31
    static let hostKeyAlgorithm = "ssh-ed25519"
    static let kexAlgorithms = ["curve25519-sha256", "curve25519-sha256@libssh.org"]
    static let clientBanner = "SSH-2.0-BellTeam"

    /// Cipher, MAC and compression lists are valid and never used: the exchange stops before NEWKEYS.
    static func clientKexInit(cookie: Data = Data((0..<16).map { _ in UInt8.random(in: 0...255) })) -> Data {
        let ciphers = "chacha20-poly1305@openssh.com,aes256-ctr"
        let lists = [kexAlgorithms.joined(separator: ","), hostKeyAlgorithm, ciphers, ciphers,
                     "hmac-sha2-256", "hmac-sha2-256", "none", "none", "", ""]
        var payload = Data([kexMessageInit]) + cookie
        for list in lists { payload.append(SSHWire.string(list)) }
        return payload + Data([0]) + SSHWire.uint32(0)
    }

    struct ServerKexInit: Equatable {
        let kexAlgorithms: [String]
        let hostKeyAlgorithms: [String]
        let firstKexPacketFollows: Bool

        init(payload: Data) throws {
            var reader = SSHWire.Reader(payload)
            guard try reader.byte() == SSHHostKey.kexMessageInit else { throw SSHHostKeyError.malformed("not SSH_MSG_KEXINIT") }
            _ = try reader.bytes(16)
            kexAlgorithms = try reader.nameList()
            hostKeyAlgorithms = try reader.nameList()
            for _ in 0..<8 { _ = try reader.string() }
            firstKexPacketFollows = try reader.byte() != 0
        }

        /// The kex both sides share (the client's order wins), or the typed reason there is none.
        func negotiate() throws -> String {
            guard hostKeyAlgorithms.contains(SSHHostKey.hostKeyAlgorithm) else {
                throw SSHHostKeyError.unsupported("this sshd offers no \(SSHHostKey.hostKeyAlgorithm) host key")
            }
            guard let kex = SSHHostKey.kexAlgorithms.first(where: kexAlgorithms.contains) else {
                throw SSHHostKeyError.unsupported("this sshd offers no curve25519-sha256 key exchange")
            }
            // A guessed first packet would have to be skipped; OpenSSH never sends one.
            guard !firstKexPacketFollows else { throw SSHHostKeyError.unsupported("this sshd sends a guessed key-exchange packet") }
            return kex
        }
    }

    static func ecdhInit(publicKey: Curve25519.KeyAgreement.PublicKey) -> Data {
        Data([ecdhInit]) + SSHWire.string(publicKey.rawRepresentation)
    }

    struct Reply: Equatable {
        let hostKey: Data
        let serverEphemeral: Data
        let signature: Data

        init(payload: Data) throws {
            var reader = SSHWire.Reader(payload)
            guard try reader.byte() == SSHHostKey.ecdhReply else { throw SSHHostKeyError.malformed("not SSH_MSG_KEX_ECDH_REPLY") }
            hostKey = try reader.string()
            serverEphemeral = try reader.string()
            signature = try reader.string()
        }
    }

    /// Everything one exchange sends and receives that the hash covers (V_C, V_S, I_C, I_S) plus the reply.
    struct Exchange {
        let clientBanner: Data
        let serverBanner: Data
        let clientKexInit: Data
        let serverKexInit: Data
        let ephemeral: Curve25519.KeyAgreement.PrivateKey
        let reply: Data
    }

    /// RFC 5656 section 4 / RFC 8731 section 3.1: H = SHA256(V_C, V_S, I_C, I_S, K_S, Q_C, Q_S, K), verified against K_S.
    /// The fingerprint comes out only for a signature that verifies; otherwise this throws.
    static func fingerprint(_ exchange: Exchange) throws -> String {
        let reply = try Reply(payload: exchange.reply)
        var key = SSHWire.Reader(reply.hostKey)
        guard String(decoding: try key.string(), as: UTF8.self) == hostKeyAlgorithm else {
            throw SSHHostKeyError.unsupported("the host key is not \(hostKeyAlgorithm)")
        }
        let publicKey = try key.string()
        var signature = SSHWire.Reader(reply.signature)
        guard String(decoding: try signature.string(), as: UTF8.self) == hostKeyAlgorithm else {
            throw SSHHostKeyError.unsupported("the signature is not \(hostKeyAlgorithm)")
        }
        let signatureBytes = try signature.string()
        guard key.remaining == 0, signature.remaining == 0 else { throw SSHHostKeyError.malformed("trailing bytes") }
        guard let serverKey = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: reply.serverEphemeral),
              let secret = try? exchange.ephemeral.sharedSecretFromKeyAgreement(with: serverKey),
              let verifier = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else {
            throw SSHHostKeyError.malformed("key sizes")
        }
        let k = secret.withUnsafeBytes { Data($0) }
        let hashed = SSHWire.string(exchange.clientBanner) + SSHWire.string(exchange.serverBanner)
            + SSHWire.string(exchange.clientKexInit) + SSHWire.string(exchange.serverKexInit)
            + SSHWire.string(reply.hostKey) + SSHWire.string(exchange.ephemeral.publicKey.rawRepresentation)
            + SSHWire.string(reply.serverEphemeral) + SSHWire.mpint(k)
        guard verifier.isValidSignature(signatureBytes, for: Data(SHA256.hash(data: hashed))) else { throw SSHHostKeyError.badSignature }
        return format(hostKey: reply.hostKey)
    }

    /// `ssh-keygen -l` form: SHA256: + unpadded base64 of the SHA-256 of the key blob.
    static func format(hostKey: Data) -> String {
        "SHA256:" + Data(SHA256.hash(data: hostKey)).base64EncodedString().replacingOccurrences(of: "=", with: "")
    }
}
