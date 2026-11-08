import Foundation

/// 契約で「必須だがnull可」の項目。キーの欠落をnullとみなさず、応答不正にする。
@propertyWrapper
struct NullableField<Value: Decodable & Equatable>: Decodable, Equatable {
    var wrappedValue: Value?

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        wrappedValue = container.decodeNil() ? nil : try container.decode(Value.self)
    }
}

/// 任意の補足項目。欠落や読めない値（未知の列挙など）はその項目だけ無いものとし、応答全体を不正にしない。
@propertyWrapper
struct LenientField<Value: Decodable & Equatable>: Decodable, Equatable {
    var wrappedValue: Value?
    init(wrappedValue: Value?) { self.wrappedValue = wrappedValue }
    init(from decoder: Decoder) throws { wrappedValue = try? decoder.singleValueContainer().decode(Value.self) }
}

extension KeyedDecodingContainer {
    func decode<Value>(_ type: LenientField<Value>.Type, forKey key: Key) throws -> LenientField<Value> {
        LenientField(wrappedValue: try? decodeIfPresent(Value.self, forKey: key))
    }
}

/// 新しいサーバーが値を足しても画面全体を読めなくしないため、未知の値はその項目のunknownとして読む。
protocol UnknownDecodable: RawRepresentable, Decodable where RawValue == String {
    static var unknownCase: Self { get }
}

extension UnknownDecodable {
    init(from decoder: Decoder) throws {
        self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? Self.unknownCase
    }
}

/// `GET /api/updates`（`bellteam.updates.v1`）。schemaの不一致だけは別契約なので応答不正。他の列挙の未知の値はunknownとして読む。
struct UpdateInventory: Decodable, Equatable {
    enum Schema: String, Decodable { case v1 = "bellteam.updates.v1" }
    struct Server: Decodable, Equatable { @NullableField var id: String? }
    struct Notice: Decodable, Equatable {
        enum State: String, UnknownDecodable { case ready, unavailable, updating, attention, unknown; static let unknownCase = State.unknown }
        let state: State
        @NullableField var code: String?
        let message: String
    }

    let schema: Schema
    let server: Server
    let observedAt: String
    let notice: Notice
    let components: [UpdateComponent]
    let plans: [UpdatePlan]
    @NullableField var operation: UpdateOperation?
    @NullableField var previousOperation: UpdateOperation?
    /// 新しいサーバーだけが返す。旧サーバーでは無い。
    let jobs: [UpdateJob]?
    let problems: [UpdateProblem]?

    var hasAvailableUpdate: Bool { components.contains { $0.comparison.state == .updateAvailable } }
}

struct UpdateVersion: Decodable, Equatable {
    enum Origin: String, UnknownDecodable { case container, builtin, release, published, unknown; static let unknownCase = Origin.unknown }
    let version: String
    @NullableField var sourceCommit: String?
    @NullableField var digest: String?
    let origin: Origin
}

struct UpdateCapability: Decodable, Equatable {
    let supported: Bool
    @NullableField var reason: String?
}

struct UpdateComponent: Decodable, Equatable, Identifiable {
    struct Comparison: Decodable, Equatable {
        enum State: String, UnknownDecodable {
            case upToDate = "up_to_date", updateAvailable = "update_available", unavailable, incompatible, unknown
            static let unknownCase = State.unknown
        }
        let state: State
        @NullableField var reason: String?
    }
    struct Publication: Decodable, Equatable {
        struct Catalog: Decodable, Equatable { let sha256: String; let publishedAt: String; let expiresAt: String }
        struct Check: Decodable, Equatable {
            enum Status: String, UnknownDecodable { case verified, failed, unconfirmed, unknown; static let unknownCase = Status.unknown }
            let status: Status
            @NullableField var checkedAt: String?
            @NullableField var error: String?
        }
        let catalog: Catalog
        let check: Check
    }
    struct Availability: Decodable, Equatable {
        @NullableField var available: Bool?
        @NullableField var reason: String?
    }

    /// 機能ごとの状態の1行（本体 c1a32534 以降）。旧サーバーには無い。`line`はサーバーの文をそのまま出す。
    /// 読めない時（未知のtone等）はその機能だけnilにし、従来の表示へ戻す。
    struct PartStatus: Decodable, Equatable {
        enum Tone: String, Decodable { case ok, updating, attention }
        struct LatestJob: Decodable, Equatable {
            enum Kind: String, Decodable { case container, module, runtime }
            enum Outcome: String, Decodable { case running, succeeded, failed }
            let jobId: String
            let kind: Kind
            let state: UpdateJob.State
            let outcome: Outcome
            let at: String
            let reason: UpdateJob.Reason?
        }
        let line: String
        let tone: Tone
        let actionRequired: Bool
        let action: String?
        let latestJob: LatestJob?
    }

    let id: String
    let name: String
    let description: String
    @LenientField var status: PartStatus?
    @NullableField var current: UpdateVersion?
    @NullableField var published: UpdateVersion?
    let comparison: Comparison
    @NullableField var publication: Publication?
    let changes: [String]
    let capability: UpdateCapability
    let availability: Availability
}

struct UpdatePlan: Decodable, Equatable {
    enum Scope: String, UnknownDecodable { case all, component, unknown; static let unknownCase = Scope.unknown }
    enum Action: String, UnknownDecodable { case update, rollback, unknown; static let unknownCase = Action.unknown }
    struct Target: Decodable, Equatable {
        let componentId: String
        @NullableField var current: UpdateVersion?
        let published: UpdateVersion
    }
    struct Compatibility: Decodable, Equatable {
        let compatible: Bool
        @NullableField var reason: String?
    }
    struct Impact: Decodable, Equatable { let containerRestart: Bool; let description: String }

    let planId: String
    let scope: Scope
    @NullableField var componentId: String?
    let expiresAt: String
    let targets: [Target]
    let compatibility: Compatibility
    let impact: Impact
    let capability: UpdateCapability
    // 旧い計画にはactionが無い。無い時は更新を意味する。
    let action: Action?
}

struct UpdateOperation: Decodable, Equatable {
    /// pendingは全stepの受付記録が揃う前の付帯情報で、ジョブの状態ではない。
    enum Admission: String, UnknownDecodable { case pending, accepted, rejected, unknown; static let unknownCase = Admission.unknown }
    enum Phase: String, UnknownDecodable {
        case preparing, applying, reconnecting, verifying, completed, failed, unknown
        static let unknownCase = Phase.unknown
    }
    enum Outcome: String, UnknownDecodable { case pending, succeeded, failed, unknown; static let unknownCase = Outcome.unknown }
    struct Failure: Decodable, Equatable { let code: String; let message: String }

    let requestId: String
    let plan: UpdatePlan
    let admission: Admission
    let phase: Phase
    let execution: Outcome
    let verification: Outcome
    @NullableField var error: Failure?
    @NullableField var reference: String?
    let jobs: [UpdateJob]?

    var isCompleted: Bool { phase == .completed && admission == .accepted && execution == .succeeded && verification == .succeeded }
    /// 結果が確定し、同じ要求を照会し続ける必要がない状態。unknownは確定ではない。
    var isSettled: Bool { admission == .rejected || isCompleted || (phase == .failed && execution == .failed) }
}

/// runtimeの`bellteam.update-job.v1`。値は作り替えず、そのまま表示する。
struct UpdateJob: Decodable, Equatable, Identifiable {
    enum Schema: String, Decodable { case v1 = "bellteam.update-job.v1" }
    enum Kind: String, UnknownDecodable { case module, container, unknown; static let unknownCase = Kind.unknown }
    enum State: String, UnknownDecodable {
        case queued, downloading, verifying, swapping, ready, failed, unknown
        static let unknownCase = State.unknown
    }
    struct Target: Decodable, Equatable { let moduleId: String }
    struct Reason: Decodable, Equatable { let code: String; let message: String }

    let schema: Schema
    let jobId: String
    let kind: Kind
    let target: Target
    let state: State
    @NullableField var reason: Reason?
    var id: String { "\(kind.rawValue):\(jobId)" }
}

/// 機能の再起動が続いた時の問題。statusは解決後もresolvedとして残る。
struct UpdateProblem: Decodable, Equatable, Identifiable {
    enum Status: String, UnknownDecodable { case open, resolved, unknown; static let unknownCase = Status.unknown }
    struct LastExit: Decodable, Equatable {
        @NullableField var code: Int?
        @NullableField var signal: String?
    }
    let fingerprint: String
    let status: Status
    let kind: String
    let moduleId: String
    let count: Int
    let windowSeconds: Int
    let lastExit: LastExit
    let lastReason: String
    var id: String { fingerprint }
}

/// 端末に保存した要求。サーバーの値を作り替えない。
struct UpdateSavedRequest: Codable, Equatable { let requestId: String; let planId: String? }

struct UpdatePlanResponse: Decodable { let plan: UpdatePlan }
struct UpdateOperationResponse: Decodable { let operation: UpdateOperation }

struct UpdatePlanRequest: Encodable {
    enum Scope: String, Encodable { case all, component }
    let scope: Scope
    let componentId: String?
}

struct UpdateOperationRequest: Encodable {
    let planId: String
    let requestId: String
    let confirmContainerRestart: Bool
}
