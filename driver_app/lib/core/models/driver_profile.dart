import 'package:cloud_firestore/cloud_firestore.dart';
import 'truck_type.dart';

/// Immutable monthly cancellation counter tracking driver cancellation quota.
class MonthlyCancelCount {
  final String month;
  final int count;

  const MonthlyCancelCount({
    required this.month,
    required this.count,
  });

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MonthlyCancelCount &&
          runtimeType == other.runtimeType &&
          month == other.month &&
          count == other.count;

  @override
  int get hashCode => month.hashCode ^ count.hashCode;
}

/// Immutable model representing the driver document in `drivers/{uid}`.
class DriverProfile {
  final String uid;
  final String name;
  final String phone;
  final TruckType truckType;
  final String vehicleNumber;
  final bool isOnDuty;
  final String? verificationStatus;
  final Map<String, dynamic>? verificationDocs;
  final String? rejectionReason;
  final DateTime? bannedUntil;
  final String? activeJobId;
  final String? activeOfferId;
  final String? activeDutySessionId;
  final int? dutyGeneration;
  final int? lifecycleSeq;
  final bool? workerReady;
  final int walletBalance;
  final MonthlyCancelCount? monthlyCancelCount;
  final bool strictMode;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  const DriverProfile({
    required this.uid,
    required this.name,
    required this.phone,
    required this.truckType,
    required this.vehicleNumber,
    this.isOnDuty = false,
    this.verificationStatus,
    this.verificationDocs,
    this.rejectionReason,
    this.bannedUntil,
    this.activeJobId,
    this.activeOfferId,
    this.activeDutySessionId,
    this.dutyGeneration,
    this.lifecycleSeq,
    this.workerReady,
    this.walletBalance = 0,
    this.monthlyCancelCount,
    this.strictMode = false,
    this.createdAt,
    this.updatedAt,
  });

  /// Wallet balance formatted as decimal Rupees (e.g. ₹500.00 from 50000 paise).
  double get walletBalanceRupees => walletBalance / 100.0;
  String get formattedWalletBalance => '₹${walletBalanceRupees.toStringAsFixed(2)}';

  /// Whether the driver's current balance is below the informational warning threshold (₹200 = 20000 paise).
  bool get isLowBalance => walletBalance < 20000;

  /// Checks if the driver's balance is below a specific threshold in paise.
  bool isBalanceBelow(int minimumRequiredPaise) => walletBalance < minimumRequiredPaise;

  bool get isApproved => verificationStatus == 'approved';
  bool get isPendingVerification => verificationStatus == 'pending';
  bool get isRejectedVerification => verificationStatus == 'rejected';
  bool get isUnsubmittedVerification =>
      verificationStatus == null || verificationStatus!.isEmpty;

  /// Returns true if driver is temporarily banned relative to the supplied [now] clock boundary.
  bool isTemporarilyBannedAt(DateTime now) {
    return bannedUntil != null && bannedUntil!.isAfter(now);
  }

  /// Convenience getter for whether driver is currently temporarily paused.
  bool get isTemporarilyPaused => isTemporarilyBannedAt(DateTime.now());

  /// Returns true if the driver has an active assigned towing job.
  bool get hasActiveJob => activeJobId != null && activeJobId!.isNotEmpty;

  /// Returns true if the driver has a pending dispatch job offer.
  bool get hasActiveOffer => activeOfferId != null && activeOfferId!.isNotEmpty;

  /// Returns true if the driver has an active assigned job or pending job offer.
  bool get hasActiveEngagement => hasActiveJob || hasActiveOffer;

  /// Returns true if all required Stage 1 profile fields are populated.
  bool get isCompleted {
    return uid.isNotEmpty &&
        name.trim().isNotEmpty &&
        phone.trim().isNotEmpty &&
        vehicleNumber.trim().isNotEmpty;
  }

  /// Factory to parse profile from Firestore document snapshot.
  factory DriverProfile.fromFirestore(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data();
    if (data == null) {
      throw StateError('Driver document snapshot has no data');
    }
    return DriverProfile.fromMap(data, doc.id);
  }

  /// Factory to parse from raw map with strict fail-closed type and schema validation.
  /// Throws [FormatException] if any field is missing, has an incorrect type, or has an invalid value.
  factory DriverProfile.fromMap(Map<String, dynamic> data, String docId) {
    if (docId.trim().isEmpty) {
      throw const FormatException('Driver profile document ID cannot be empty');
    }

    if (!data.containsKey('uid')) {
      throw const FormatException('Driver profile missing required field: uid');
    }
    final rawUid = data['uid'];
    if (rawUid == null) {
      throw const FormatException('Driver profile missing required field: uid');
    }
    if (rawUid is! String) {
      throw FormatException('Driver profile uid must be a string, got ${rawUid.runtimeType}');
    }
    if (rawUid.trim().isEmpty) {
      throw const FormatException('Driver profile uid cannot be blank');
    }
    if (rawUid != docId) {
      throw FormatException('Driver profile uid mismatch: expected "$docId", got "$rawUid"');
    }

    final rawName = data['name'];
    if (rawName == null) {
      throw const FormatException('Driver profile missing required field: name');
    }
    if (rawName is! String) {
      throw FormatException('Driver profile name must be a string, got ${rawName.runtimeType}');
    }

    final rawPhone = data['phone'];
    if (rawPhone == null) {
      throw const FormatException('Driver profile missing required field: phone');
    }
    if (rawPhone is! String) {
      throw FormatException('Driver profile phone must be a string, got ${rawPhone.runtimeType}');
    }

    final rawTruckType = data['truckType'];
    if (rawTruckType == null) {
      throw const FormatException('Driver profile missing required field: truckType');
    }
    final parsedTruckType = TruckType.tryParse(rawTruckType);
    if (parsedTruckType == null) {
      throw FormatException('Driver profile contains invalid truckType: "$rawTruckType"');
    }

    final rawVehicleNumber = data['vehicleNumber'];
    if (rawVehicleNumber == null) {
      throw const FormatException('Driver profile missing required field: vehicleNumber');
    }
    if (rawVehicleNumber is! String) {
      throw FormatException('Driver profile vehicleNumber must be a string, got ${rawVehicleNumber.runtimeType}');
    }

    final rawIsOnDuty = data['isOnDuty'];
    if (rawIsOnDuty != null && rawIsOnDuty is! bool) {
      throw FormatException('Driver profile isOnDuty must be a boolean, got ${rawIsOnDuty.runtimeType}');
    }

    final rawVerificationStatus = data['verificationStatus'];
    String? parsedVerificationStatus;
    if (rawVerificationStatus != null) {
      if (rawVerificationStatus is! String) {
        throw FormatException('Driver profile verificationStatus must be a string, got ${rawVerificationStatus.runtimeType}');
      }
      if (rawVerificationStatus != 'pending' &&
          rawVerificationStatus != 'approved' &&
          rawVerificationStatus != 'rejected') {
        throw FormatException('Driver profile contains invalid verificationStatus: "$rawVerificationStatus"');
      }
      parsedVerificationStatus = rawVerificationStatus;
    }

    final rawVerificationDocs = data['verificationDocs'];
    Map<String, dynamic>? parsedVerificationDocs;
    if (rawVerificationDocs != null) {
      if (rawVerificationDocs is! Map) {
        throw FormatException('Driver profile verificationDocs must be a map, got ${rawVerificationDocs.runtimeType}');
      }
      final docsMap = Map<String, dynamic>.from(rawVerificationDocs);
      for (final key in ['idPhotoUrl', 'rcPhotoUrl', 'selfiePhotoUrl']) {
        if (!docsMap.containsKey(key) || docsMap[key] == null) {
          throw FormatException('Driver profile verificationDocs missing required field: $key');
        }
        if (docsMap[key] is! String || (docsMap[key] as String).trim().isEmpty) {
          throw FormatException('Driver profile verificationDocs.$key must be a non-empty string');
        }
      }
      if (!docsMap.containsKey('submittedAt') || docsMap['submittedAt'] == null) {
        throw const FormatException('Driver profile verificationDocs missing required field: submittedAt');
      }
      final rawSubmittedAt = docsMap['submittedAt'];
      if (rawSubmittedAt is! Timestamp && rawSubmittedAt is! DateTime) {
        throw FormatException('Driver profile verificationDocs.submittedAt must be a Timestamp, got ${rawSubmittedAt.runtimeType}');
      }
      parsedVerificationDocs = docsMap;
    }

    final rawRejectionReason = data['rejectionReason'];
    String? parsedRejectionReason;
    if (rawRejectionReason != null) {
      if (rawRejectionReason is! String) {
        throw FormatException('Driver profile rejectionReason must be a string, got ${rawRejectionReason.runtimeType}');
      }
      parsedRejectionReason = rawRejectionReason.trim();
    }

    DateTime? parseTimestamp(dynamic value, String fieldName) {
      if (value == null) return null;
      if (value is Timestamp) return value.toDate();
      if (value is DateTime) return value;
      throw FormatException('Driver profile $fieldName must be a Timestamp, got ${value.runtimeType}');
    }

    DateTime? parseBannedUntil(dynamic value) {
      if (value == null) return null;
      if (value is Timestamp) return value.toDate();
      throw FormatException('Driver profile bannedUntil must be a Timestamp, got ${value.runtimeType}');
    }

    final rawActiveJobId = data['activeJobId'];
    String? parsedActiveJobId;
    if (rawActiveJobId != null) {
      if (rawActiveJobId is! String) {
        throw FormatException('Driver profile activeJobId must be a string, got ${rawActiveJobId.runtimeType}');
      }
      if (rawActiveJobId.isEmpty || rawActiveJobId != rawActiveJobId.trim()) {
        throw FormatException('Driver profile activeJobId must be a non-empty canonical string, got "$rawActiveJobId"');
      }
      parsedActiveJobId = rawActiveJobId;
    }

    final rawActiveOfferId = data['activeOfferId'];
    String? parsedActiveOfferId;
    if (rawActiveOfferId != null) {
      if (rawActiveOfferId is! String) {
        throw FormatException('Driver profile activeOfferId must be a string, got ${rawActiveOfferId.runtimeType}');
      }
      if (rawActiveOfferId.isEmpty || rawActiveOfferId != rawActiveOfferId.trim()) {
        throw FormatException('Driver profile activeOfferId must be a non-empty canonical string, got "$rawActiveOfferId"');
      }
      parsedActiveOfferId = rawActiveOfferId;
    }

    final rawActiveDutySessionId = data['activeDutySessionId'];
    String? parsedActiveDutySessionId;
    if (rawActiveDutySessionId != null) {
      if (rawActiveDutySessionId is! String) {
        throw FormatException('Driver profile activeDutySessionId must be a string, got ${rawActiveDutySessionId.runtimeType}');
      }
      if (rawActiveDutySessionId.isEmpty || rawActiveDutySessionId != rawActiveDutySessionId.trim()) {
        throw FormatException('Driver profile activeDutySessionId must be a non-empty canonical string, got "$rawActiveDutySessionId"');
      }
      parsedActiveDutySessionId = rawActiveDutySessionId;
    }

    final rawDutyGeneration = data['dutyGeneration'];
    int? parsedDutyGeneration;
    if (rawDutyGeneration != null) {
      if (rawDutyGeneration is! int) {
        throw FormatException('Driver profile dutyGeneration must be an integer, got ${rawDutyGeneration.runtimeType}');
      }
      if (rawDutyGeneration < 0) {
        throw FormatException('Driver profile dutyGeneration must be non-negative, got $rawDutyGeneration');
      }
      parsedDutyGeneration = rawDutyGeneration;
    }

    final rawLifecycleSeq = data['lifecycleSeq'];
    int? parsedLifecycleSeq;
    if (rawLifecycleSeq != null) {
      if (rawLifecycleSeq is! int) {
        throw FormatException('Driver profile lifecycleSeq must be an integer, got ${rawLifecycleSeq.runtimeType}');
      }
      if (rawLifecycleSeq <= 0) {
        throw FormatException('Driver profile lifecycleSeq must be positive, got $rawLifecycleSeq');
      }
      parsedLifecycleSeq = rawLifecycleSeq;
    }

    final rawWorkerReady = data['workerReady'];
    bool? parsedWorkerReady;
    if (rawWorkerReady != null) {
      if (rawWorkerReady is! bool) {
        throw FormatException('Driver profile workerReady must be a boolean, got ${rawWorkerReady.runtimeType}');
      }
      parsedWorkerReady = rawWorkerReady;
    }

    final rawWalletBalance = data['walletBalance'];
    int parsedWalletBalance = 0;
    if (data.containsKey('walletBalance')) {
      if (rawWalletBalance == null) {
        throw const FormatException('Driver profile walletBalance cannot be null');
      }
      if (rawWalletBalance is! int) {
        throw FormatException('Driver profile walletBalance must be an integer, got ${rawWalletBalance.runtimeType}');
      }
      if (rawWalletBalance < 0) {
        throw FormatException('Driver profile walletBalance must be non-negative, got $rawWalletBalance');
      }
      if (rawWalletBalance > 9007199254740991) {
        throw FormatException('Driver profile walletBalance exceeds JavaScript max safe integer, got $rawWalletBalance');
      }
      parsedWalletBalance = rawWalletBalance;
    }

    final rawMonthlyCancelCount = data['monthlyCancelCount'];
    MonthlyCancelCount? parsedMonthlyCancelCount;
    if (rawMonthlyCancelCount != null) {
      if (rawMonthlyCancelCount is int) {
        if (rawMonthlyCancelCount < 0) {
          throw FormatException('Driver profile monthlyCancelCount must be non-negative, got $rawMonthlyCancelCount');
        }
        parsedMonthlyCancelCount = MonthlyCancelCount(
          month: '',
          count: rawMonthlyCancelCount,
        );
      } else if (rawMonthlyCancelCount is Map) {
        final rawMonth = rawMonthlyCancelCount['month'];
        final rawCount = rawMonthlyCancelCount['count'];
        if (rawMonth is! String || rawMonth.trim().isEmpty) {
          throw const FormatException('Driver profile monthlyCancelCount.month must be a non-empty string');
        }
        if (rawCount is! int || rawCount < 0) {
          throw FormatException('Driver profile monthlyCancelCount.count must be a non-negative integer, got $rawCount');
        }
        parsedMonthlyCancelCount = MonthlyCancelCount(
          month: rawMonth.trim(),
          count: rawCount,
        );
      } else {
        throw FormatException('Driver profile monthlyCancelCount must be a Map or int, got ${rawMonthlyCancelCount.runtimeType}');
      }
    }

    final rawStrictMode = data['strictMode'];
    bool parsedStrictMode = false;
    if (rawStrictMode != null) {
      if (rawStrictMode is! bool) {
        throw FormatException('Driver profile strictMode must be a boolean, got ${rawStrictMode.runtimeType}');
      }
      parsedStrictMode = rawStrictMode;
    }

    return DriverProfile(
      uid: rawUid,
      name: rawName.trim(),
      phone: rawPhone.trim(),
      truckType: parsedTruckType,
      vehicleNumber: rawVehicleNumber.trim(),
      isOnDuty: (rawIsOnDuty as bool?) ?? false,
      verificationStatus: parsedVerificationStatus,
      verificationDocs: parsedVerificationDocs,
      rejectionReason: parsedRejectionReason,
      bannedUntil: parseBannedUntil(data['bannedUntil']),
      activeJobId: parsedActiveJobId,
      activeOfferId: parsedActiveOfferId,
      activeDutySessionId: parsedActiveDutySessionId,
      dutyGeneration: parsedDutyGeneration,
      lifecycleSeq: parsedLifecycleSeq,
      workerReady: parsedWorkerReady,
      walletBalance: parsedWalletBalance,
      monthlyCancelCount: parsedMonthlyCancelCount,
      strictMode: parsedStrictMode,
      createdAt: parseTimestamp(data['createdAt'], 'createdAt'),
      updatedAt: parseTimestamp(data['updatedAt'], 'updatedAt'),
    );
  }

  /// Constructs the exact 8-field allowlisted payload required by Firestore rules
  /// for driver document creation (`allow create`).
  ///
  /// Strictly contains: `uid`, `name`, `phone`, `truckType`, `vehicleNumber`,
  /// `isOnDuty`, `createdAt`, and `updatedAt`.
  /// Excludes all server-owned fields (`walletBalance`, `canFlatbed`, etc.).
  Map<String, dynamic> toInitialCreatePayload({Object? serverTimestampToken}) {
    final timestamp = serverTimestampToken ?? FieldValue.serverTimestamp();
    return <String, dynamic>{
      'uid': uid,
      'name': name.trim(),
      'phone': phone.trim(),
      'truckType': truckType.backendValue,
      'vehicleNumber': vehicleNumber.trim().toUpperCase(),
      'isOnDuty': false,
      'createdAt': timestamp,
      'updatedAt': timestamp,
    };
  }

  /// Clone with updated fields.
  DriverProfile copyWith({
    String? uid,
    String? name,
    String? phone,
    TruckType? truckType,
    String? vehicleNumber,
    bool? isOnDuty,
    String? verificationStatus,
    Map<String, dynamic>? verificationDocs,
    String? rejectionReason,
    DateTime? bannedUntil,
    String? activeJobId,
    String? activeOfferId,
    String? activeDutySessionId,
    int? dutyGeneration,
    int? lifecycleSeq,
    bool? workerReady,
    int? walletBalance,
    MonthlyCancelCount? monthlyCancelCount,
    bool? strictMode,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) {
    return DriverProfile(
      uid: uid ?? this.uid,
      name: name ?? this.name,
      phone: phone ?? this.phone,
      truckType: truckType ?? this.truckType,
      vehicleNumber: vehicleNumber ?? this.vehicleNumber,
      isOnDuty: isOnDuty ?? this.isOnDuty,
      verificationStatus: verificationStatus ?? this.verificationStatus,
      verificationDocs: verificationDocs ?? this.verificationDocs,
      rejectionReason: rejectionReason ?? this.rejectionReason,
      bannedUntil: bannedUntil ?? this.bannedUntil,
      activeJobId: activeJobId ?? this.activeJobId,
      activeOfferId: activeOfferId ?? this.activeOfferId,
      activeDutySessionId: activeDutySessionId ?? this.activeDutySessionId,
      dutyGeneration: dutyGeneration ?? this.dutyGeneration,
      lifecycleSeq: lifecycleSeq ?? this.lifecycleSeq,
      workerReady: workerReady ?? this.workerReady,
      walletBalance: walletBalance ?? this.walletBalance,
      monthlyCancelCount: monthlyCancelCount ?? this.monthlyCancelCount,
      strictMode: strictMode ?? this.strictMode,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DriverProfile &&
          runtimeType == other.runtimeType &&
          uid == other.uid &&
          name == other.name &&
          phone == other.phone &&
          truckType == other.truckType &&
          vehicleNumber == other.vehicleNumber &&
          isOnDuty == other.isOnDuty &&
          verificationStatus == other.verificationStatus &&
          rejectionReason == other.rejectionReason &&
          bannedUntil == other.bannedUntil &&
          activeJobId == other.activeJobId &&
          activeOfferId == other.activeOfferId &&
          activeDutySessionId == other.activeDutySessionId &&
          dutyGeneration == other.dutyGeneration &&
          lifecycleSeq == other.lifecycleSeq &&
          workerReady == other.workerReady &&
          walletBalance == other.walletBalance &&
          monthlyCancelCount == other.monthlyCancelCount &&
          strictMode == other.strictMode;

  @override
  int get hashCode =>
      uid.hashCode ^
      name.hashCode ^
      phone.hashCode ^
      truckType.hashCode ^
      vehicleNumber.hashCode ^
      isOnDuty.hashCode ^
      verificationStatus.hashCode ^
      rejectionReason.hashCode ^
      bannedUntil.hashCode ^
      activeJobId.hashCode ^
      activeOfferId.hashCode ^
      activeDutySessionId.hashCode ^
      dutyGeneration.hashCode ^
      lifecycleSeq.hashCode ^
      workerReady.hashCode ^
      walletBalance.hashCode ^
      monthlyCancelCount.hashCode ^
      strictMode.hashCode;
}
