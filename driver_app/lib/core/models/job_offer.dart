import 'package:cloud_firestore/cloud_firestore.dart';

/// Status values for [JobOffer].
enum JobOfferStatus {
  offered,
  accepted,
  inProgress,
  completed,
  declined,
  expired,
  cancelledCustomer,
  cancelledDriver,
  superseded,
  unknown;

  static JobOfferStatus fromString(String? value) {
    switch (value) {
      case 'offered':
        return JobOfferStatus.offered;
      case 'accepted':
        return JobOfferStatus.accepted;
      case 'in_progress':
        return JobOfferStatus.inProgress;
      case 'completed':
        return JobOfferStatus.completed;
      case 'declined':
        return JobOfferStatus.declined;
      case 'expired':
        return JobOfferStatus.expired;
      case 'cancelled_customer':
        return JobOfferStatus.cancelledCustomer;
      case 'cancelled_driver':
        return JobOfferStatus.cancelledDriver;
      case 'superseded':
        return JobOfferStatus.superseded;
      default:
        return JobOfferStatus.unknown;
    }
  }

  String toDbString() {
    switch (this) {
      case JobOfferStatus.offered:
        return 'offered';
      case JobOfferStatus.accepted:
        return 'accepted';
      case JobOfferStatus.inProgress:
        return 'in_progress';
      case JobOfferStatus.completed:
        return 'completed';
      case JobOfferStatus.declined:
        return 'declined';
      case JobOfferStatus.expired:
        return 'expired';
      case JobOfferStatus.cancelledCustomer:
        return 'cancelled_customer';
      case JobOfferStatus.cancelledDriver:
        return 'cancelled_driver';
      case JobOfferStatus.superseded:
        return 'superseded';
      case JobOfferStatus.unknown:
        return 'unknown';
    }
  }
}

/// Geographic coordinate pair ({lat, lng}).
class OfferCoordinates {
  final double lat;
  final double lng;

  const OfferCoordinates({required this.lat, required this.lng});

  factory OfferCoordinates.fromMap(dynamic map) {
    if (map is! Map) {
      throw const FormatException('Coordinates must be a Map');
    }
    final rawLat = map['lat'];
    final rawLng = map['lng'];
    if (rawLat is! num || rawLng is! num) {
      throw const FormatException('Coordinates lat and lng must be numbers');
    }
    final lat = rawLat.toDouble();
    final lng = rawLng.toDouble();
    if (lat.isNaN || lat.isInfinite || lng.isNaN || lng.isInfinite) {
      throw const FormatException('Coordinates cannot be NaN or Infinite');
    }
    return OfferCoordinates(lat: lat, lng: lng);
  }

  Map<String, double> toMap() => {'lat': lat, 'lng': lng};

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is OfferCoordinates &&
          runtimeType == other.runtimeType &&
          lat == other.lat &&
          lng == other.lng;

  @override
  int get hashCode => lat.hashCode ^ lng.hashCode;
}

/// Sanitized, driver-facing projection of an offer from `job_offers/{offerId}`.
///
/// Strictly conforms to the 26-field allowlist defined in `job_offers_schema.json`.
class JobOffer {
  final String id;
  final String jobId;
  final String driverId;
  final int dispatchGeneration;
  final int? candidateIndex;
  final int? roundIndex;
  final JobOfferStatus status;
  final DateTime offeredAt;
  final DateTime expiresAt;
  final DateTime? resolvedAt;
  final String? resolutionReason;
  final DateTime? acceptedAt;
  final DateTime? inProgressAt;
  final DateTime? completedAt;
  final String? acceptRequestId;
  final Map<String, dynamic>? cancellationPolicySnapshot;
  final OfferCoordinates pickupCoords;
  final OfferCoordinates destCoords;
  final String requestedTruckType;
  final num? pickupRoutedDistanceMeters;
  final num? pickupEtaSeconds;
  final int estimatedFarePaise;
  final int driverCommissionPaise;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  const JobOffer({
    required this.id,
    required this.jobId,
    required this.driverId,
    required this.dispatchGeneration,
    this.candidateIndex,
    this.roundIndex,
    required this.status,
    required this.offeredAt,
    required this.expiresAt,
    this.resolvedAt,
    this.resolutionReason,
    this.acceptedAt,
    this.inProgressAt,
    this.completedAt,
    this.acceptRequestId,
    this.cancellationPolicySnapshot,
    required this.pickupCoords,
    required this.destCoords,
    required this.requestedTruckType,
    this.pickupRoutedDistanceMeters,
    this.pickupEtaSeconds,
    required this.estimatedFarePaise,
    required this.driverCommissionPaise,
    this.createdAt,
    this.updatedAt,
  });

  bool get isOffered => status == JobOfferStatus.offered;
  bool get isAccepted => status == JobOfferStatus.accepted;
  bool get isInProgress => status == JobOfferStatus.inProgress;
  bool get isCompleted => status == JobOfferStatus.completed;

  /// Returns true if server-derived expiry has passed relative to [now].
  bool isExpired(DateTime now) => now.isAfter(expiresAt);

  /// Remaining duration until [expiresAt] relative to [now], clamped to [0, 45s].
  Duration remainingDuration(DateTime now) {
    final diff = expiresAt.difference(now);
    if (diff.isNegative) return Duration.zero;
    return diff;
  }

  /// Informational tow fare in rupees (paid by customer to driver).
  double get estimatedFareRupees => estimatedFarePaise / 100.0;

  /// Platform commission in rupees debited from driver wallet.
  double get driverCommissionRupees => driverCommissionPaise / 100.0;

  /// Pickup distance in kilometers if available.
  double? get pickupDistanceKm =>
      pickupRoutedDistanceMeters != null ? pickupRoutedDistanceMeters! / 1000.0 : null;

  /// Pickup ETA in minutes if available.
  int? get pickupEtaMinutes =>
      pickupEtaSeconds != null ? (pickupEtaSeconds! / 60.0).ceil() : null;

  /// Parses a Firestore document snapshot into [JobOffer], failing closed on corrupt/missing data.
  factory JobOffer.fromFirestore(DocumentSnapshot<Map<String, dynamic>> snapshot) {
    if (!snapshot.exists || snapshot.data() == null) {
      throw const FormatException('JobOffer document does not exist or has null data');
    }
    return JobOffer.fromMap(snapshot.id, snapshot.data()!);
  }

  /// Parses raw data map into [JobOffer]. Fails closed with [FormatException].
  factory JobOffer.fromMap(String id, Map<String, dynamic> data) {
    if (id.isEmpty) {
      throw const FormatException('JobOffer id cannot be empty');
    }

    final rawJobId = data['jobId'];
    if (rawJobId is! String || rawJobId.trim().isEmpty) {
      throw const FormatException('JobOffer jobId must be a non-empty string');
    }

    final rawDriverId = data['driverId'];
    if (rawDriverId is! String || rawDriverId.trim().isEmpty) {
      throw const FormatException('JobOffer driverId must be a non-empty string');
    }

    final rawGen = data['dispatchGeneration'];
    if (rawGen is! int || rawGen <= 0) {
      throw const FormatException('JobOffer dispatchGeneration must be a positive integer');
    }

    final rawStatus = data['status'];
    if (rawStatus is! String || rawStatus.trim().isEmpty) {
      throw const FormatException('JobOffer status must be a non-empty string');
    }
    final status = JobOfferStatus.fromString(rawStatus);

    DateTime parseTimestamp(dynamic value, String fieldName) {
      if (value is Timestamp) return value.toDate();
      if (value is DateTime) return value;
      throw FormatException('JobOffer $fieldName must be a Timestamp, got ${value.runtimeType}');
    }

    DateTime? parseNullableTimestamp(dynamic value, String fieldName) {
      if (value == null) return null;
      return parseTimestamp(value, fieldName);
    }

    final offeredAt = parseTimestamp(data['offeredAt'], 'offeredAt');
    final expiresAt = parseTimestamp(data['expiresAt'], 'expiresAt');

    final rawCommission = data['driverCommissionPaise'];
    if (rawCommission is! int || rawCommission <= 0) {
      throw const FormatException('JobOffer driverCommissionPaise must be a positive safe integer');
    }

    final rawFare = data['estimatedFarePaise'];
    if (rawFare is! int || rawFare < 0) {
      throw const FormatException('JobOffer estimatedFarePaise must be a non-negative safe integer');
    }

    final pickupCoords = OfferCoordinates.fromMap(data['pickupCoords']);
    final destCoords = OfferCoordinates.fromMap(data['destCoords']);

    final rawTruck = data['requestedTruckType'];
    if (rawTruck is! String || rawTruck.trim().isEmpty) {
      throw const FormatException('JobOffer requestedTruckType must be a non-empty string');
    }

    return JobOffer(
      id: id,
      jobId: rawJobId.trim(),
      driverId: rawDriverId.trim(),
      dispatchGeneration: rawGen,
      candidateIndex: data['candidateIndex'] as int?,
      roundIndex: data['roundIndex'] as int?,
      status: status,
      offeredAt: offeredAt,
      expiresAt: expiresAt,
      resolvedAt: parseNullableTimestamp(data['resolvedAt'], 'resolvedAt'),
      resolutionReason: data['resolutionReason'] as String?,
      acceptedAt: parseNullableTimestamp(data['acceptedAt'], 'acceptedAt'),
      inProgressAt: parseNullableTimestamp(data['inProgressAt'], 'inProgressAt'),
      completedAt: parseNullableTimestamp(data['completedAt'], 'completedAt'),
      acceptRequestId: data['acceptRequestId'] as String?,
      cancellationPolicySnapshot: data['cancellationPolicySnapshot'] is Map
          ? Map<String, dynamic>.from(data['cancellationPolicySnapshot'] as Map)
          : null,
      pickupCoords: pickupCoords,
      destCoords: destCoords,
      requestedTruckType: rawTruck.trim(),
      pickupRoutedDistanceMeters: data['pickupRoutedDistanceMeters'] as num?,
      pickupEtaSeconds: data['pickupEtaSeconds'] as num?,
      estimatedFarePaise: rawFare,
      driverCommissionPaise: rawCommission,
      createdAt: parseNullableTimestamp(data['createdAt'], 'createdAt'),
      updatedAt: parseNullableTimestamp(data['updatedAt'], 'updatedAt'),
    );
  }

  Map<String, dynamic> toMap() {
    return {
      'id': id,
      'jobId': jobId,
      'driverId': driverId,
      'dispatchGeneration': dispatchGeneration,
      if (candidateIndex != null) 'candidateIndex': candidateIndex,
      if (roundIndex != null) 'roundIndex': roundIndex,
      'status': status.toDbString(),
      'offeredAt': offeredAt,
      'expiresAt': expiresAt,
      if (resolvedAt != null) 'resolvedAt': resolvedAt,
      if (resolutionReason != null) 'resolutionReason': resolutionReason,
      if (acceptedAt != null) 'acceptedAt': acceptedAt,
      if (inProgressAt != null) 'inProgressAt': inProgressAt,
      if (completedAt != null) 'completedAt': completedAt,
      if (acceptRequestId != null) 'acceptRequestId': acceptRequestId,
      if (cancellationPolicySnapshot != null) 'cancellationPolicySnapshot': cancellationPolicySnapshot,
      'pickupCoords': pickupCoords.toMap(),
      'destCoords': destCoords.toMap(),
      'requestedTruckType': requestedTruckType,
      if (pickupRoutedDistanceMeters != null) 'pickupRoutedDistanceMeters': pickupRoutedDistanceMeters,
      if (pickupEtaSeconds != null) 'pickupEtaSeconds': pickupEtaSeconds,
      'estimatedFarePaise': estimatedFarePaise,
      'driverCommissionPaise': driverCommissionPaise,
      if (createdAt != null) 'createdAt': createdAt,
      if (updatedAt != null) 'updatedAt': updatedAt,
    };
  }
}
