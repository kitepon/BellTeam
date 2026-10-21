import Foundation

@main
struct BotStopContractChecks {
    static func main() throws {
        let decoder = JSONDecoder()
        func outcome(_ body: String, status: Int, id: String) throws -> BotStopOutcome? {
            try decoder.decode(BotStopResponse.self, from: Data(body.utf8))
                .outcome(httpStatus: status, expectedBotId: id)
        }

        let sent = #"{"botId":"bot-a","status":"stop_sent"}"#
        let confirmed = #"{"botId":"bot-a","status":"interrupted","sessionPreserved":true}"#
        let closed = #"{"botId":"bot-a","status":"interrupted","sessionPreserved":false}"#
        guard try outcome(sent, status: 202, id: "bot-a") == .sent,
              try outcome(confirmed, status: 200, id: "bot-a") == .confirmed,
              try outcome(sent, status: 200, id: "bot-a") == nil,
              try outcome(confirmed, status: 202, id: "bot-a") == nil,
              try outcome(closed, status: 200, id: "bot-a") == nil,
              try outcome(sent, status: 202, id: "bot-b") == nil else {
            fatalError("停止APIの応答判定が契約と一致しません")
        }
        do {
            _ = try decoder.decode(BotStopResponse.self, from: Data(#"{"status":"stop_sent"}"#.utf8))
            fatalError("botId欠落を受け付けました")
        } catch is DecodingError {
            print("停止API応答の合成確認: 7件成功")
        }
    }
}
