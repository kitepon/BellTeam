import CryptoKit
import Darwin
import Foundation

// F-SEAT-HOST S1/S2 on the Mac app (docs/architecture/modules/apple/terminals.md): this Mac's own addresses and user, whether
// Remote Login answers on loopback, and its sshd host-key fingerprint over a loopback handshake. Local facts only; nothing secret.

enum ThisMac {
    /// Mac Catalyst only; the iPhone shows none of this.
    static var isThisMac: Bool { ProcessInfo.processInfo.isMacCatalystApp }

    static let sharingSettingsURL = URL(string: "x-apple.systempreferences:com.apple.Sharing-Settings.extension")!

    struct Interface: Equatable {
        let name: String
        let address: String
        let isIPv6: Bool
    }

    /// Every up interface address (loopback and link-local included, for ownership checks).
    static func interfaces() -> [Interface] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }
        var result: [Interface] = []
        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let entry = pointer.pointee
            guard let addr = entry.ifa_addr, Int32(entry.ifa_flags) & IFF_UP != 0 else { continue }
            let family = Int32(addr.pointee.sa_family)
            var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
            let ok: Bool
            switch family {
            case AF_INET:
                ok = addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { inet_ntop(AF_INET, &$0.pointee.sin_addr, &buffer, socklen_t(buffer.count)) != nil }
            case AF_INET6:
                ok = addr.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { inet_ntop(AF_INET6, &$0.pointee.sin6_addr, &buffer, socklen_t(buffer.count)) != nil }
            default: continue
            }
            if ok { result.append(Interface(name: String(cString: entry.ifa_name), address: String(cString: buffer), isIPv6: family == AF_INET6)) }
        }
        return result
    }

    /// The first non-loopback, non-link-local IPv4 address, `en0` first (S1 host).
    static func primaryIPv4(_ interfaces: [Interface] = ThisMac.interfaces()) -> String? {
        let usable = interfaces.filter { !$0.isIPv6 && !$0.address.hasPrefix("127.") && !$0.address.hasPrefix("169.254.") }
        return (usable.first { $0.name == "en0" } ?? usable.first)?.address
    }

    /// `NSUserName()` is the real login name in the sandbox (the home folder is the container).
    static var userName: String { NSUserName() }

    /// The BSD host name (no DNS lookup), e.g. `kites-macbook.local`.
    static func hostName() -> String? {
        var buffer = [CChar](repeating: 0, count: 256)
        return gethostname(&buffer, buffer.count) == 0 ? String(cString: buffer) : nil
    }

    /// A terminal host that is this Mac: an interface address, loopback, localhost or this Mac's own host name.
    /// No other name is resolved, so a different Mac that merely answers on the network is never taken for this one.
    static func owns(host: String, interfaces: [Interface] = ThisMac.interfaces(), hostName: String? = ThisMac.hostName()) -> Bool {
        let text = host.lowercased()
        if text.isEmpty { return false }
        if text.contains(":") || text.wholeMatch(of: /[0-9.]+/) != nil {
            guard let wanted = canonical(text) else { return false }
            return wanted == "127.0.0.1" || wanted == "::1" || interfaces.contains { canonical($0.address) == wanted }
        }
        if text == "localhost" { return true }
        guard let own = hostName?.lowercased(), !own.isEmpty else { return false }
        return text == own || text == own + ".local" || own == text + ".local"
    }

    /// Same address in one spelling (IPv6 shortening, an `%en0` zone dropped); nil when it is not an IP address.
    private static func canonical(_ address: String) -> String? {
        let bare = String(address.split(separator: "%", maxSplits: 1)[0])
        var v4 = in_addr(), v6 = in6_addr()
        var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
        if inet_pton(AF_INET, bare, &v4) == 1 { return inet_ntop(AF_INET, &v4, &buffer, socklen_t(buffer.count)).map { String(cString: $0) } }
        if inet_pton(AF_INET6, bare, &v6) == 1 { return inet_ntop(AF_INET6, &v6, &buffer, socklen_t(buffer.count)).map { String(cString: $0) } }
        return nil
    }

    // MARK: Loopback sshd

    enum RemoteLogin: Equatable {
        case on
        /// Connection refused on 127.0.0.1:22: nothing listens, so Remote Login is off.
        case off
        /// Anything else (timeout, unexpected error): not enough to say it is off.
        case unknown(String)
    }

    static func remoteLogin(port: Int = 22, timeout: TimeInterval = 2) async -> RemoteLogin {
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "-bellbot-preview-remote-login"), arguments.indices.contains(index + 1), arguments[index + 1] == "off" { return .off }
        #endif
        return await Task.detached {
            do { _ = try LoopbackSocket(port: port, deadline: Date().addingTimeInterval(timeout)); return RemoteLogin.on }
            catch SSHHostKeyError.connection(let reason) where reason == "refused" { return .off }
            catch { return .unknown(String(describing: error)) }
        }.value
    }

    /// S2: the sshd host-key fingerprint, or a typed error (refused, timeout, no ed25519, bad signature). Nothing is sent after the reply.
    static func hostKeyFingerprint(port: Int, timeout: TimeInterval = 5) async throws -> String {
        try await Task.detached { try fingerprint(port: port, deadline: Date().addingTimeInterval(timeout)).fingerprint }.value
    }

    static func fingerprint(port: Int, deadline: Date) throws -> (fingerprint: String, exchange: SSHHostKey.Exchange) {
        let socket = try LoopbackSocket(port: port, deadline: deadline)
        let clientBanner = Data(SSHHostKey.clientBanner.utf8)
        let clientKexInit = SSHHostKey.clientKexInit()
        try socket.write(clientBanner + Data("\r\n".utf8) + SSHWire.packet(clientKexInit))
        let serverBanner = try socket.readBanner()
        let serverKexInit = try socket.readPacket(expecting: SSHHostKey.kexMessageInit)
        let server = try SSHHostKey.ServerKexInit(payload: serverKexInit)
        _ = try server.negotiate()
        let ephemeral = Curve25519.KeyAgreement.PrivateKey()
        try socket.write(SSHWire.packet(SSHHostKey.ecdhInit(publicKey: ephemeral.publicKey)))
        let exchange = SSHHostKey.Exchange(clientBanner: clientBanner, serverBanner: serverBanner, clientKexInit: clientKexInit,
                                           serverKexInit: serverKexInit, ephemeral: ephemeral,
                                           reply: try socket.readPacket(expecting: SSHHostKey.ecdhReply))
        return (try SSHHostKey.fingerprint(exchange), exchange)
    }
}

/// A blocking TCP socket to 127.0.0.1 with one overall deadline. Closed when released.
final class LoopbackSocket {
    private let descriptor: Int32
    private let deadline: Date
    private var buffer = Data()

    init(port: Int, deadline: Date) throws {
        self.deadline = deadline
        descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw SSHHostKeyError.connection("socket") }
        var on: Int32 = 1
        setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        _ = fcntl(descriptor, F_SETFL, fcntl(descriptor, F_GETFL) | O_NONBLOCK)
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(port).bigEndian
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let status = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        // A throw from here on still runs deinit, which closes the descriptor.
        if status != 0 {
            guard errno == EINPROGRESS else { throw SSHHostKeyError.connection(errno == ECONNREFUSED ? "refused" : "errno \(errno)") }
            try wait(POLLOUT)
            var failure: Int32 = 0
            var length = socklen_t(MemoryLayout<Int32>.size)
            getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &failure, &length)
            guard failure == 0 else { throw SSHHostKeyError.connection(failure == ECONNREFUSED ? "refused" : "errno \(failure)") }
        }
    }

    deinit { close(descriptor) }

    private func wait(_ events: Int32) throws {
        var poller = pollfd(fd: descriptor, events: Int16(events), revents: 0)
        let milliseconds = Int32(max(0, deadline.timeIntervalSinceNow * 1000))
        guard milliseconds > 0, poll(&poller, 1, milliseconds) > 0 else { throw SSHHostKeyError.connection("timeout") }
    }

    func write(_ data: Data) throws {
        var sent = 0
        while sent < data.count {
            try wait(POLLOUT)
            let count = data.withUnsafeBytes { send(descriptor, $0.baseAddress! + sent, data.count - sent, 0) }
            guard count > 0 || (count < 0 && errno == EAGAIN) else { throw SSHHostKeyError.connection("closed") }
            if count > 0 { sent += count }
        }
    }

    private func fill() throws {
        try wait(POLLIN)
        var chunk = [UInt8](repeating: 0, count: 4096)
        let count = recv(descriptor, &chunk, chunk.count, 0)
        if count == 0 { throw SSHHostKeyError.connection("closed") }
        if count < 0 { guard errno == EAGAIN else { throw SSHHostKeyError.connection("errno \(errno)") }; return }
        buffer.append(contentsOf: chunk[0..<count])
    }

    private func take(_ count: Int) throws -> Data {
        while buffer.count < count { try fill() }
        defer { buffer = Data(buffer.dropFirst(count)) }
        return Data(buffer.prefix(count))
    }

    /// RFC 4253 section 4.2: lines before the first `SSH-` line are ignored. Returns it without CR LF.
    func readBanner() throws -> Data {
        for _ in 0..<64 {
            while !buffer.contains(0x0A) {
                guard buffer.count < 512 else { throw SSHHostKeyError.malformed("banner line") }
                try fill()
            }
            let end = buffer.firstIndex(of: 0x0A)!
            var line = Data(buffer[buffer.startIndex..<end])
            buffer = Data(buffer[(end + 1)...])
            if line.last == 0x0D { line.removeLast() }
            if line.starts(with: Data("SSH-".utf8)) { return line }
        }
        throw SSHHostKeyError.malformed("no SSH banner")
    }

    /// The payload of the next packet of that message type; IGNORE and DEBUG are skipped, anything else is an error.
    func readPacket(expecting type: UInt8) throws -> Data {
        while true {
            let length = try take(4).reduce(0) { $0 << 8 | Int($1) }
            guard length >= 6, length <= 35000 else { throw SSHHostKeyError.malformed("packet length") }
            let payload = try SSHWire.payload(ofPacketBody: try take(length))
            switch payload.first {
            case type?: return payload
            case 2?, 4?: continue
            case 1?: throw SSHHostKeyError.connection("disconnected by sshd")
            default: throw SSHHostKeyError.malformed("unexpected message \(payload.first.map(String.init) ?? "-")")
            }
        }
    }
}
