import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:driver_app/core/models/job_offer.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('JobOffer Model Tests', () {
    final now = DateTime(2026, 10, 6, 12, 0, 0);
    final expiresAt = now.add(const Duration(seconds: 45));

    Map<String, dynamic> createValidOfferMap() {
      return {
        'jobId': 'job_456',
        'driverId': 'driver_789',
        'dispatchGeneration': 1,
        'candidateIndex': 0,
        'status': 'offered',
        'pickupCoords': {'lat': 18.5204, 'lng': 73.8567},
        'destCoords': {'lat': 18.5500, 'lng': 73.8800},
        'pickupAddress': 'Swargate, Pune',
        'destAddress': 'Koregaon Park, Pune',
        'requestedTruckType': 'flatbed',
        'pickupRoutedDistanceMeters': 5400,
        'pickupEtaSeconds': 600,
        'estimatedFarePaise': 250000, // ₹2,500.00
        'driverCommissionPaise': 37500, // ₹375.00
        'offeredAt': Timestamp.fromDate(now),
        'expiresAt': Timestamp.fromDate(expiresAt),
        'createdAt': Timestamp.fromDate(now),
        'updatedAt': Timestamp.fromDate(now),
        'cancellationPolicySnapshot': {
          'freeCancellationsPerMonth': 2,
          'driverPenaltyPaise': 5000,
        },
      };
    }

    test('parses full valid offer map successfully with correct derived properties', () {
      final map = createValidOfferMap();
      final offer = JobOffer.fromMap('offer_123', map);

      expect(offer.id, equals('offer_123'));
      expect(offer.jobId, equals('job_456'));
      expect(offer.driverId, equals('driver_789'));
      expect(offer.dispatchGeneration, equals(1));
      expect(offer.candidateIndex, equals(0));
      expect(offer.status, equals(JobOfferStatus.offered));
      expect(offer.pickupCoords.lat, closeTo(18.5204, 0.0001));
      expect(offer.pickupCoords.lng, closeTo(73.8567, 0.0001));
      expect(offer.destCoords.lat, closeTo(18.5500, 0.0001));
      expect(offer.destCoords.lng, closeTo(73.8800, 0.0001));
      expect(offer.requestedTruckType, equals('flatbed'));
      expect(offer.pickupRoutedDistanceMeters, equals(5400));
      expect(offer.pickupDistanceKm, closeTo(5.4, 0.01));
      expect(offer.pickupEtaSeconds, equals(600));
      expect(offer.pickupEtaMinutes, equals(10));
      expect(offer.estimatedFarePaise, equals(250000));
      expect(offer.estimatedFareRupees, equals(2500.00));
      expect(offer.driverCommissionPaise, equals(37500));
      expect(offer.driverCommissionRupees, equals(375.00));
      expect(offer.cancellationPolicySnapshot, isNotNull);
      expect(offer.cancellationPolicySnapshot!['freeCancellationsPerMonth'], equals(2));
      expect(offer.isOffered, isTrue);
      expect(offer.isAccepted, isFalse);
    });

    test('computes truthful countdown and expiry against reference time', () {
      final map = createValidOfferMap();
      final offer = JobOffer.fromMap('offer_123', map);

      // 15 seconds after offer: 30s remaining
      final t1 = now.add(const Duration(seconds: 15));
      expect(offer.isExpired(t1), isFalse);
      expect(offer.remainingDuration(t1), equals(const Duration(seconds: 30)));

      // Exact expiry moment: 0s remaining
      expect(offer.remainingDuration(expiresAt), equals(Duration.zero));

      // After expiry: isExpired is true, duration clamped to zero
      final t2 = expiresAt.add(const Duration(seconds: 10));
      expect(offer.isExpired(t2), isTrue);
      expect(offer.remainingDuration(t2), equals(Duration.zero));
    });

    test('fails closed with FormatException when essential fields are missing', () {
      final requiredFields = [
        'jobId',
        'driverId',
        'dispatchGeneration',
        'status',
        'expiresAt',
        'pickupCoords',
        'destCoords',
        'requestedTruckType',
        'estimatedFarePaise',
        'driverCommissionPaise',
      ];

      for (final field in requiredFields) {
        final map = createValidOfferMap();
        map.remove(field);

        expect(
          () => JobOffer.fromMap('offer_123', map),
          throwsA(isA<FormatException>()),
          reason: 'Expected FormatException when $field is missing',
        );
      }
    });

    test('fails closed with FormatException when coordinates are malformed', () {
      // Missing lat
      final badCoords1 = createValidOfferMap()..['pickupCoords'] = {'lng': 73.8567};
      expect(() => JobOffer.fromMap('offer_123', badCoords1), throwsA(isA<FormatException>()));

      // Non-numeric lng
      final badCoords2 = createValidOfferMap()..['pickupCoords'] = {'lat': 18.52, 'lng': 'invalid'};
      expect(() => JobOffer.fromMap('offer_123', badCoords2), throwsA(isA<FormatException>()));

      // Not a Map
      final badCoords3 = createValidOfferMap()..['destCoords'] = '18.55, 73.88';
      expect(() => JobOffer.fromMap('offer_123', badCoords3), throwsA(isA<FormatException>()));
    });

    test('parses unknown status cleanly as unknown', () {
      final map = createValidOfferMap()..['status'] = 'unknown_status_xyz';
      final offer = JobOffer.fromMap('offer_123', map);
      expect(offer.status, equals(JobOfferStatus.unknown));
      expect(offer.isOffered, isFalse);
    });

    test('parses all valid JobOfferStatus enum values correctly', () {
      expect(JobOfferStatus.fromString('offered'), equals(JobOfferStatus.offered));
      expect(JobOfferStatus.fromString('accepted'), equals(JobOfferStatus.accepted));
      expect(JobOfferStatus.fromString('declined'), equals(JobOfferStatus.declined));
      expect(JobOfferStatus.fromString('expired'), equals(JobOfferStatus.expired));
      expect(JobOfferStatus.fromString('superseded'), equals(JobOfferStatus.superseded));

      expect(JobOfferStatus.offered.toDbString(), equals('offered'));
      expect(JobOfferStatus.accepted.toDbString(), equals('accepted'));
      expect(JobOfferStatus.declined.toDbString(), equals('declined'));
      expect(JobOfferStatus.expired.toDbString(), equals('expired'));
      expect(JobOfferStatus.superseded.toDbString(), equals('superseded'));
    });

    test('serializes to Map conforming to sanitized schema', () {
      final map = createValidOfferMap();
      final offer = JobOffer.fromMap('offer_123', map);
      final serialized = offer.toMap();

      expect(serialized['id'], equals('offer_123'));
      expect(serialized['jobId'], equals('job_456'));
      expect(serialized['status'], equals('offered'));
      expect(serialized['estimatedFarePaise'], equals(250000));
      expect(serialized['driverCommissionPaise'], equals(37500));
    });
  });
}
