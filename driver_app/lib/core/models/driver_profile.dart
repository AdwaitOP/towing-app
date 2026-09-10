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
  final DateTime? createdAt;
  final DateTime? updatedAt;

  const DriverProfile({
    required this.uid,
    required this.name,
    required this.phone,
    required this.truckType,
    required this.vehicleNumber,
    this.isOnDuty = false,
    this.createdAt,
    this.updatedAt,
  });

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
          isOnDuty == other.isOnDuty;

  @override
  int get hashCode =>
      uid.hashCode ^
      name.hashCode ^
      phone.hashCode ^
      truckType.hashCode ^
      vehicleNumber.hashCode ^
      isOnDuty.hashCode;
}
