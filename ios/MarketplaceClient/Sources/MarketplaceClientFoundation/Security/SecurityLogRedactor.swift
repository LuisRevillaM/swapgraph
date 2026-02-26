import Foundation

public enum SecurityLogRedactor {
    public static func redact(_ input: String) -> String {
        var output = input
        let patterns = [
            #"(?i)Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*"#,
            #"(?i)(Idempotency-Key[:=]\s*)([A-Za-z0-9\-_]+)"#,
            #"(?i)(x-correlation-id[:=]\s*)([A-Za-z0-9\-_]+)"#
        ]

        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern) else {
                continue
            }

            let range = NSRange(output.startIndex..<output.endIndex, in: output)
            if pattern.contains("Idempotency-Key") || pattern.contains("x-correlation-id") {
                output = regex.stringByReplacingMatches(
                    in: output,
                    options: [],
                    range: range,
                    withTemplate: "$1<redacted>"
                )
            } else {
                output = regex.stringByReplacingMatches(
                    in: output,
                    options: [],
                    range: range,
                    withTemplate: "Bearer <redacted>"
                )
            }
        }

        return output
    }
}
