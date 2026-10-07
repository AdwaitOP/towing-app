import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DriverProfile Stage 3 Unit Tests', () {
    final baseValidMap = <String, dynamic>{
      'uid': 'driver_123',
      'name': 'Rajesh Kumar',
      'phone': '+919876543210',
      'truckType': 'flatbed',
      'vehicleNumber': 'MH 12 AB 1234',
      'verificationStatus': 'approved',
      'isOnDuty': false,
    };

    group('bannedUntil parsing and validation', () {
      test('parses bannedUntil from Timestamp correctly', () {
        final banTime = DateTime.utc(2026, 9, 15, 12, 0, 0);
        final map = Map<String, dynamic>.from(baseValidMap)
          ..['bannedUntil'] = Timestamp.fromDate(banTime);

        final profile = DriverProfile.fromMap(map, 'driver_123');
        expect(profile.bannedUntil!.isAtSameMomentAs(banTime), isTrue);
      });

      test('bannedUntil from DateTime throws FormatException (Timestamp only)', () {
        final banTime = DateTime.utc(2026, 9, 15, 12, 0, 0);
        final map = Map<String, dynamic>.from(baseValidMap)
          ..['bannedUntil'] = banTime;

        expect(
          () => DriverProfile.fromMap(map, 'driver_123'),
          throwsA(isA<FormatException>()),
        );
      });

      test('parses null bannedUntil as null', () {
        final map = Map<String, dynamic>.from(baseValidMap)
          ..['bannedUntil'] = null;

        final profile = DriverProfile.fromMap(map, 'driver_123');
        expect(profile.bannedUntil, isNull);
      });

      test('omitted bannedUntil defaults to null', () {
        final profile = DriverProfile.fromMap(baseValidMap, 'driver_123');
        expect(profile.bannedUntil, isNull);
      });

      test('malformed bannedUntil string throws FormatException (fail closed)', () {
        final map = Map<String, dynamic>.from(baseValidMap)
          ..['bannedUntil'] = '2026-09-15T12:00:00Z';

        expect(
          () => DriverProfile.fromMap(map, 'driver_123'),
          throwsA(isA<FormatException>()),
        );
      });

      test('malformed bannedUntil integer throws FormatException (fail closed)', () {
        final map = Map<String, dynamic>.from(baseValidMap)
          ..['bannedUntil'] = 1750000000;

        expect(
          () => DriverProfile.fromMap(map, 'driver_123'),
          throwsA(isA<FormatException>()),
        );
      });

      test('malformed bannedUntil bool throws FormatException (fail closed)', () {
        final map = Map<String, dynamic>.from(baseValidMap)
          ..['bannedUntil'] = true;

        expect(
          () => DriverProfile.fromMap(map, 'driver_123'),
          throwsA(isA<FormatException>()),
        );
      });
    });

    group('isTemporarilyBannedAt clock boundary', () {
      final banEnd = DateTime.utc(2026, 9, 13, 15, 0, 0);
      final profile = DriverProfile(
        uid: 'driver_123',
        name: 'Rajesh Kumar',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        bannedUntil: banEnd,
      );

      test('returns true when now is before bannedUntil', () {
        final now = DateTime.utc(2026, 9, 13, 14, 59, 59);
        expect(profile.isTemporarilyBannedAt(now), isTrue);
      });

      test('returns false when now equals bannedUntil', () {
        expect(profile.isTemporarilyBannedAt(banEnd), isFalse);
      });

      test('returns false when now is after bannedUntil', () {
        final now = DateTime.utc(2026, 9, 13, 15, 0, 1);
        expect(profile.isTemporarilyBannedAt(now), isFalse);
      });

      test('returns false when bannedUntil is null', () {
        const unbannedProfile = DriverProfile(
          uid: 'driver_123',
          name: 'Rajesh Kumar',
          phone: '+919876543210',
          truckType: TruckType.flatbed,
          vehicleNumber: 'MH 12 AB 1234',
          bannedUntil: null,
        );
        expect(unbannedProfile.isTemporarilyBannedAt(DateTime.now()), isFalse);
      });
    });

    group('activeJobId and hasActiveJob', () {
      test('parses activeJobId string correctly', () {
        final map = Map<String, dynamic>.from(baseValidMap)
          ..['activeJobId'] = 'job_abc_789';

        final profile = DriverProfile.fromMap(map, 'driver_123');
        expect(profile.activeJobId, equals('job_abc_789'));
        expect(profile.hasActiveJob, isTrue);
      });

      test('parses null activeJobId correctly', () {
        final map = Map<String, dynamic>.from(baseValidMap)
          ..['activeJobId'] = null;

        final profile = DriverProfile.fromMap(map, 'driver_123');
        expect(profile.activeJobId, isNull);
        expect(profile.hasActiveJob, isFalse);
      });

      test('empty activeJobId throws FormatException', () {
        final map = Map<String, dynamic>.from(baseValidMap)
          ..['activeJobId'] = '';

        expect(
          () => DriverProfile.fromMap(map, 'driver_123'),
          throwsA(isA<FormatException>()),
        );
      });

      test('whitespace-only or padded activeJobId throws FormatException', () {
        for (final val in ['   ', ' job_1 ']) {
          final map = Map<String, dynamic>.from(baseValidMap)
            ..['activeJobId'] = val;

          expect(
            () => DriverProfile.fromMap(map, 'driver_123'),
            throwsA(isA<FormatException>()),
          );
        }
      });

      test('non-string activeJobId throws FormatException (fail closed)', () {
        final map = Map<String, dynamic>.from(baseValidMap)
          ..['activeJobId'] = 12345;

        expect(
          () => DriverProfile.fromMap(map, 'driver_123'),
          throwsA(isA<FormatException>()),
        );
      });
    });

    group('activeDutySessionId, dutyGeneration, and workerReady', () {
      test('parses activeDutySessionId, dutyGeneration, workerReady correctly', () {
        final map = Map<String, dynamic>.from(baseValidMap)
          ..['activeDutySessionId'] = 'sess_123_456'
          ..['dutyGeneration'] = 4
          ..['workerReady'] = true;

        final profile = DriverProfile.fromMap(map, 'driver_123');
        expect(profile.activeDutySessionId, equals('sess_123_456'));
        expect(profile.dutyGeneration, equals(4));
        expect(profile.workerReady, isTrue);
      });

      test('defaults to null when omitted', () {
        final profile = DriverProfile.fromMap(baseValidMap, 'driver_123');
        expect(profile.activeDutySessionId, isNull);
        expect(profile.dutyGeneration, isNull);
        expect(profile.workerReady, isNull);
      });

      test('malformed activeDutySessionId throws FormatException', () {
        final map = Map<String, dynamic>.from(baseValidMap)
          ..['activeDutySessionId'] = 9999;
        expect(
          () => DriverProfile.fromMap(map, 'driver_123'),
          throwsA(isA<FormatException>()),
        );
      });

      test('malformed dutyGeneration throws FormatException', () {
        final map = Map<String, dynamic>.from(baseValidMap)
          ..['dutyGeneration'] = 'not-an-int';
        expect(
          () => DriverProfile.fromMap(map, 'driver_123'),
          throwsA(isA<FormatException>()),
        );
      });

      test('malformed workerReady throws FormatException', () {
        final map = Map<String, dynamic>.from(baseValidMap)
          ..['workerReady'] = 'not-a-bool';
        expect(
          () => DriverProfile.fromMap(map, 'driver_123'),
          throwsA(isA<FormatException>()),
        );
      });
    });
  });
}
