import 'package:cloud_firestore/cloud_firestore.dart';
import 'truck_type.dart';

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
    this.createdAt,
    this.updatedAt,
  });

  bool get isApproved => verificationStatus == 'approved';
  bool get isPendingVerification => verificationStatus == 'pending';
  bool get isRejectedVerification => verificationStatus == 'rejected';
  bool get isUnsubmittedVerification =>
      verificationStatus == null || verificationStatus!.isEmpty;

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
          rejectionReason == other.rejectionReason;

  @override
  int get hashCode =>
      uid.hashCode ^
      name.hashCode ^
      phone.hashCode ^
      truckType.hashCode ^
      vehicleNumber.hashCode ^
      isOnDuty.hashCode ^
      verificationStatus.hashCode ^
      rejectionReason.hashCode;
}
