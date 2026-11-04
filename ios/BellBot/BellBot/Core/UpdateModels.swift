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

/// `GET /api/updates`（`bellteam.updates.v1`）。列挙の未知の値はdecode失敗＝応答不正として扱う。
struct UpdateInventory: Decodable, Equatable {
    enum Schema: String, Decodable { case v1 = "bellteam.updates.v1" }
    struct Server: Decodable, Equatable { @NullableField var id: String? }
    struct Notice: Decodable, Equatable {
        enum State: String, Decodable { case ready, unavailable, updating, attention }
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

    var hasAvailableUpdate: Bool { components.contains { $0.comparison.state == .updateAvailable } }
}

struct UpdateVersion: Decodable, Equatable {
    enum Origin: String, Decodable { case container, builtin, release, published }
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
        enum State: String, Decodable {
            case upToDate = "up_to_date", updateAvailable = "update_available", unavailable, incompatible, unknown
        }
        let state: State
        @NullableField var reason: String?
    }
    struct Publication: Decodable, Equatable {
        struct Catalog: Decodable, Equatable { let sha256: String; let publishedAt: String; let expiresAt: String }
        struct Check: Decodable, Equatable {
            enum Status: String, Decodable { case verified, failed, unconfirmed }
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

    let id: String
    let name: String
    let description: String
    @NullableField var current: UpdateVersion?
    @NullableField var published: UpdateVersion?
    let comparison: Comparison
    @NullableField var publication: Publication?
    let changes: [String]
    let capability: UpdateCapability
    let availability: Availability
}

struct UpdatePlan: Decodable, Equatable {
    enum Scope: String, Decodable { case all, component }
    enum Action: String, Decodable { case update, rollback }
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
    enum Admission: String, Decodable { case accepted, rejected, unknown }
    enum Phase: String, Decodable { case preparing, applying, reconnecting, verifying, completed, failed, unknown }
    enum Outcome: String, Decodable { case pending, succeeded, failed, unknown }
    struct Failure: Decodable, Equatable { let code: String; let message: String }

    let requestId: String
    let plan: UpdatePlan
    let admission: Admission
    let phase: Phase
    let execution: Outcome
    let verification: Outcome
    @NullableField var error: Failure?
    @NullableField var reference: String?

    var isCompleted: Bool { phase == .completed && admission == .accepted && execution == .succeeded && verification == .succeeded }
    /// 結果が確定し、同じ要求を照会し続ける必要がない状態。unknownは確定ではない。
    var isSettled: Bool { admission == .rejected || isCompleted || (phase == .failed && execution == .failed) }
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
