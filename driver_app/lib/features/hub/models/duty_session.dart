import 'dart:convert';

/// Immutable session token uniquely identifying an active or in-flight ON duty session.
/// Crosses isolate boundaries via serializable payload.
class DutySession {
  final String uid;
  final String sessionId;
  final int generation;
  final int? lifecycleSeq;
  final String? notificationTitle;
  final String? notificationText;
  final String? locale;

  const DutySession({
    required this.uid,
    required this.sessionId,
    required this.generation,
    this.lifecycleSeq,
    this.notificationTitle,
    this.notificationText,
    this.locale,
  });

  Map<String, dynamic> toJson() => {
        'uid': uid,
        'sessionId': sessionId,
        'generation': generation,
        if (lifecycleSeq != null) 'lifecycleSeq': lifecycleSeq,
        if (notificationTitle != null) 'notificationTitle': notificationTitle,
        if (notificationText != null) 'notificationText': notificationText,
        if (locale != null) 'locale': locale,
      };

  factory DutySession.fromJson(Map<String, dynamic> json) {
    final uid = json['uid'] as String?;
    final sessionId = json['sessionId'] as String?;
    final generation = json['generation'] as int?;

    if (uid == null ||
        uid.trim().isEmpty ||
        sessionId == null ||
        sessionId.trim().isEmpty ||
        generation == null ||
        generation < 0) {
      throw FormatException('Invalid or incomplete DutySession JSON payload: $json');
    }

    return DutySession(
      uid: uid,
      sessionId: sessionId,
      generation: generation,
      lifecycleSeq: json['lifecycleSeq'] as int?,
      notificationTitle: json['notificationTitle'] as String?,
      notificationText: json['notificationText'] as String?,
      locale: json['locale'] as String?,
    );
  }

  String encode() => jsonEncode(toJson());

  static DutySession? tryDecode(String? raw) {
    if (raw == null || raw.trim().isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      return DutySession.fromJson(decoded);
    } catch (_) {
      return null;
    }
  }

  DutySession copyWith({
    String? uid,
    String? sessionId,
    int? generation,
    int? lifecycleSeq,
    String? notificationTitle,
    String? notificationText,
    String? locale,
  }) {
    return DutySession(
      uid: uid ?? this.uid,
      sessionId: sessionId ?? this.sessionId,
      generation: generation ?? this.generation,
      lifecycleSeq: lifecycleSeq ?? this.lifecycleSeq,
      notificationTitle: notificationTitle ?? this.notificationTitle,
      notificationText: notificationText ?? this.notificationText,
      locale: locale ?? this.locale,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DutySession &&
          runtimeType == other.runtimeType &&
          uid == other.uid &&
          sessionId == other.sessionId &&
          generation == other.generation &&
          lifecycleSeq == other.lifecycleSeq;

  @override
  int get hashCode =>
      uid.hashCode ^
      sessionId.hashCode ^
      generation.hashCode ^
      lifecycleSeq.hashCode;

  @override
  String toString() =>
      'DutySession(uid: $uid, id: $sessionId, gen: $generation, seq: $lifecycleSeq)';
}
