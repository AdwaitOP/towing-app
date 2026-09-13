import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DriverProfile Model & Payload Invariants', () {
    const testProfile = DriverProfile(
      uid: 'driver_uid_123',
      name: '  Rajesh Sharma  ',
      phone: '+919876543210',
      truckType: TruckType.hydraulic,
      vehicleNumber: '  mh 46 ab 1234  ',
      isOnDuty: false,
    );

    test('toInitialCreatePayload contains exactly the 8 allowlisted Firestore fields', () {
      final payload = testProfile.toInitialCreatePayload(serverTimestampToken: 'SERVER_TIMESTAMP');

      // Rule contract: ['uid', 'name', 'phone', 'truckType', 'vehicleNumber', 'isOnDuty', 'createdAt', 'updatedAt']
      final expectedKeys = {
        'uid',
        'name',
        'phone',
        'truckType',
        'vehicleNumber',
        'isOnDuty',
        'createdAt',
        'updatedAt',
      };

      expect(payload.keys.toSet(), equals(expectedKeys));
      expect(payload.keys.length, equals(8));

      expect(payload['uid'], equals('driver_uid_123'));
      expect(payload['name'], equals('Rajesh Sharma')); // Trimmed
      expect(payload['phone'], equals('+919876543210'));
      expect(payload['truckType'], equals('hydraulic'));
      expect(payload['vehicleNumber'], equals('MH 46 AB 1234')); // Trimmed and uppercase
      expect(payload['isOnDuty'], equals(false));
      expect(payload['createdAt'], equals('SERVER_TIMESTAMP'));
      expect(payload['updatedAt'], equals('SERVER_TIMESTAMP'));
    });

    test('toInitialCreatePayload strictly excludes all server-owned fields', () {
      final payload = testProfile.toInitialCreatePayload();

      // Ensure no server-owned or financial field is client-created
      const serverOwnedFields = [
        'walletBalance',
        'canFlatbed',
        'canPulling',
        'activeJobId',
        'activeOfferId',
        'verificationStatus',
        'verificationDocs',
        'rejectionReason',
        'bannedUntil',
        'strictMode',
        'monthlyCancelCount',
        'location',
        'locationUpdatedAt',
      ];

      for (final field in serverOwnedFields) {
        expect(payload.containsKey(field), isFalse, reason: 'Payload must not contain $field');
      }
    });

    test('fromMap parses map correctly into DriverProfile', () {
      final now = DateTime.now();
      final map = {
        'uid': 'driver_uid_456',
        'name': 'Sunil Patil',
        'phone': '+919876543211',
        'truckType': 'tochan',
        'vehicleNumber': 'MH 12 CD 5678',
        'isOnDuty': false,
        'createdAt': now,
        'updatedAt': now,
      };

      final profile = DriverProfile.fromMap(map, 'driver_uid_456');

      expect(profile.uid, equals('driver_uid_456'));
      expect(profile.name, equals('Sunil Patil'));
      expect(profile.phone, equals('+919876543211'));
      expect(profile.truckType, equals(TruckType.tochan));
      expect(profile.vehicleNumber, equals('MH 12 CD 5678'));
      expect(profile.isOnDuty, isFalse);
      expect(profile.isCompleted, isTrue);
    });

    test('isCompleted returns false when required fields are empty', () {
      final incomplete1 = DriverProfile(
        uid: 'uid1',
        name: '',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
      );
      expect(incomplete1.isCompleted, isFalse);

      final incomplete2 = DriverProfile(
        uid: 'uid2',
        name: 'Valid Name',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: '   ',
      );
      expect(incomplete2.isCompleted, isFalse);
    });

    test('fromMap rejects missing required fields and fails closed', () {
      final validMap = {
        'uid': 'uid',
        'name': 'Sunil Patil',
        'phone': '+919876543211',
        'truckType': 'tochan',
        'vehicleNumber': 'MH 12 CD 5678',
        'isOnDuty': false,
      };

      // Missing uid key
      final noUid = Map<String, dynamic>.from(validMap)..remove('uid');
      expect(() => DriverProfile.fromMap(noUid, 'uid'), throwsFormatException);

      // Null uid
      final nullUid = Map<String, dynamic>.from(validMap)..['uid'] = null;
      expect(() => DriverProfile.fromMap(nullUid, 'uid'), throwsFormatException);

      // Missing name
      final noName = Map<String, dynamic>.from(validMap)..remove('name');
      expect(() => DriverProfile.fromMap(noName, 'uid'), throwsFormatException);

      // Missing phone
      final noPhone = Map<String, dynamic>.from(validMap)..remove('phone');
      expect(() => DriverProfile.fromMap(noPhone, 'uid'), throwsFormatException);

      // Missing truckType
      final noTruckType = Map<String, dynamic>.from(validMap)..remove('truckType');
      expect(() => DriverProfile.fromMap(noTruckType, 'uid'), throwsFormatException);

      // Missing vehicleNumber
      final noVehicle = Map<String, dynamic>.from(validMap)..remove('vehicleNumber');
      expect(() => DriverProfile.fromMap(noVehicle, 'uid'), throwsFormatException);
    });

    test('fromMap rejects malformed field types and invalid enums', () {
      final validMap = {
        'uid': 'uid',
        'name': 'Sunil Patil',
        'phone': '+919876543211',
        'truckType': 'tochan',
        'vehicleNumber': 'MH 12 CD 5678',
        'isOnDuty': false,
      };

      // Name is integer
      final intName = Map<String, dynamic>.from(validMap)..['name'] = 12345;
      expect(() => DriverProfile.fromMap(intName, 'uid'), throwsFormatException);

      // TruckType is unknown enum value
      final unknownTruck = Map<String, dynamic>.from(validMap)..['truckType'] = 'submarine';
      expect(() => DriverProfile.fromMap(unknownTruck, 'uid'), throwsFormatException);

      // isOnDuty is string instead of bool
      final stringOnDuty = Map<String, dynamic>.from(validMap)..['isOnDuty'] = 'true';
      expect(() => DriverProfile.fromMap(stringOnDuty, 'uid'), throwsFormatException);

      // UID mismatch
      final uidMismatch = Map<String, dynamic>.from(validMap)..['uid'] = 'other_uid';
      expect(() => DriverProfile.fromMap(uidMismatch, 'my_uid'), throwsFormatException);
    });

    group('Persisted UID Validation Matrix (A through K)', () {
      final baseMap = {
        'uid': 'driver_123',
        'name': 'Rajesh Sharma',
        'phone': '+919876543210',
        'truckType': 'hydraulic',
        'vehicleNumber': 'MH 46 AB 1234',
        'isOnDuty': false,
      };

      test('A: uid == documentId valid non-empty string is accepted', () {
        final profile = DriverProfile.fromMap(baseMap, 'driver_123');
        expect(profile.uid, equals('driver_123'));
        expect(profile.isCompleted, isTrue);
      });

      test('B: uid == null is rejected with FormatException', () {
        final map = Map<String, dynamic>.from(baseMap)..['uid'] = null;
        expect(() => DriverProfile.fromMap(map, 'driver_123'), throwsFormatException);
      });

      test('C: uid key missing is rejected with FormatException', () {
        final map = Map<String, dynamic>.from(baseMap)..remove('uid');
        expect(() => DriverProfile.fromMap(map, 'driver_123'), throwsFormatException);
      });

      test('D: uid integer is rejected with FormatException', () {
        final map = Map<String, dynamic>.from(baseMap)..['uid'] = 12345;
        expect(() => DriverProfile.fromMap(map, 'driver_123'), throwsFormatException);
      });

      test('E: uid boolean is rejected with FormatException', () {
        final map = Map<String, dynamic>.from(baseMap)..['uid'] = true;
        expect(() => DriverProfile.fromMap(map, 'driver_123'), throwsFormatException);
      });

      test('F: uid map or list is rejected with FormatException', () {
        final mapList = Map<String, dynamic>.from(baseMap)..['uid'] = ['driver_123'];
        expect(() => DriverProfile.fromMap(mapList, 'driver_123'), throwsFormatException);

        final mapObj = Map<String, dynamic>.from(baseMap)..['uid'] = {'id': 'driver_123'};
        expect(() => DriverProfile.fromMap(mapObj, 'driver_123'), throwsFormatException);
      });

      test('G: uid == empty string is rejected with FormatException', () {
        final map = Map<String, dynamic>.from(baseMap)..['uid'] = '';
        expect(() => DriverProfile.fromMap(map, 'driver_123'), throwsFormatException);
      });

      test('H: uid == whitespace only is rejected with FormatException', () {
        final map = Map<String, dynamic>.from(baseMap)..['uid'] = '   ';
        expect(() => DriverProfile.fromMap(map, 'driver_123'), throwsFormatException);
      });

      test('I: uid valid string but != documentId is rejected with FormatException', () {
        final map = Map<String, dynamic>.from(baseMap)..['uid'] = 'other_driver_id';
        expect(() => DriverProfile.fromMap(map, 'driver_123'), throwsFormatException);
      });

      test('J: uid differs only by case is rejected (exact identity equality)', () {
        final map = Map<String, dynamic>.from(baseMap)..['uid'] = 'DRIVER_123';
        expect(() => DriverProfile.fromMap(map, 'driver_123'), throwsFormatException);
      });

      test('K: uid with leading or trailing whitespace is rejected without silent trimming', () {
        final mapLeading = Map<String, dynamic>.from(baseMap)..['uid'] = ' driver_123';
        expect(() => DriverProfile.fromMap(mapLeading, 'driver_123'), throwsFormatException);

        final mapTrailing = Map<String, dynamic>.from(baseMap)..['uid'] = 'driver_123 ';
        expect(() => DriverProfile.fromMap(mapTrailing, 'driver_123'), throwsFormatException);

        final mapBoth = Map<String, dynamic>.from(baseMap)..['uid'] = ' driver_123 ';
        expect(() => DriverProfile.fromMap(mapBoth, 'driver_123'), throwsFormatException);
      });
    });

    test('persisted document with legal server-owned fields parses cleanly without becoming malformed', () {
      final persistedDocWithServerFields = {
        'uid': 'driver_123',
        'name': 'Rajesh Sharma',
        'phone': '+919876543210',
        'truckType': 'hydraulic',
        'vehicleNumber': 'MH 46 AB 1234',
        'isOnDuty': true,
        // Legal server-owned and cross-stage fields
        'walletBalance': 1500,
        'canFlatbed': true,
        'canPulling': false,
        'activeJobId': 'job_789',
        'activeOfferId': null,
        'verificationStatus': 'approved',
        'verificationDocs': {
          'idPhotoUrl': 'https://storage/id.jpg',
          'rcPhotoUrl': 'https://storage/rc.jpg',
          'selfiePhotoUrl': 'https://storage/selfie.jpg',
          'submittedAt': DateTime.now(),
        },
        'rejectionReason': null,
        'bannedUntil': null,
        'strictMode': false,
        'monthlyCancelCount': 1,
        'location': {'lat': 18.5204, 'lng': 73.8567},
      };

      final profile = DriverProfile.fromMap(persistedDocWithServerFields, 'driver_123');
      expect(profile.uid, equals('driver_123'));
      expect(profile.name, equals('Rajesh Sharma'));
      expect(profile.phone, equals('+919876543210'));
      expect(profile.truckType, equals(TruckType.hydraulic));
      expect(profile.vehicleNumber, equals('MH 46 AB 1234'));
      expect(profile.isOnDuty, isTrue);
      expect(profile.isCompleted, isTrue);
      expect(profile.verificationStatus, equals('approved'));
      expect(profile.isApproved, isTrue);
    });

    group('Verification Status & Docs Contract Hardening', () {
      final baseMap = {
        'uid': 'driver_123',
        'name': 'Rajesh Sharma',
        'phone': '+919876543210',
        'truckType': 'hydraulic',
        'vehicleNumber': 'MH 46 AB 1234',
        'isOnDuty': false,
      };

      test('constructor defaults verificationStatus to null (unsubmitted)', () {
        const profile = DriverProfile(
          uid: 'driver_123',
          name: 'Rajesh Sharma',
          phone: '+919876543210',
          truckType: TruckType.hydraulic,
          vehicleNumber: 'MH 46 AB 1234',
        );
        expect(profile.verificationStatus, isNull);
        expect(profile.isApproved, isFalse);
        expect(profile.isPendingVerification, isFalse);
        expect(profile.isRejectedVerification, isFalse);
      });

      test('absent or null verificationStatus parses as unsubmitted (null)', () {
        final profileAbsent = DriverProfile.fromMap(baseMap, 'driver_123');
        expect(profileAbsent.verificationStatus, isNull);
        expect(profileAbsent.isApproved, isFalse);

        final mapNull = Map<String, dynamic>.from(baseMap)..['verificationStatus'] = null;
        final profileNull = DriverProfile.fromMap(mapNull, 'driver_123');
        expect(profileNull.verificationStatus, isNull);
        expect(profileNull.isApproved, isFalse);
      });

      test('canonical verificationStatus values parse accurately', () {
        final mapPending = Map<String, dynamic>.from(baseMap)..['verificationStatus'] = 'pending';
        final profilePending = DriverProfile.fromMap(mapPending, 'driver_123');
        expect(profilePending.verificationStatus, equals('pending'));
        expect(profilePending.isPendingVerification, isTrue);
        expect(profilePending.isApproved, isFalse);

        final mapApproved = Map<String, dynamic>.from(baseMap)..['verificationStatus'] = 'approved';
        final profileApproved = DriverProfile.fromMap(mapApproved, 'driver_123');
        expect(profileApproved.verificationStatus, equals('approved'));
        expect(profileApproved.isApproved, isTrue);

        final mapRejected = Map<String, dynamic>.from(baseMap)
          ..['verificationStatus'] = 'rejected'
          ..['rejectionReason'] = 'ID expired';
        final profileRejected = DriverProfile.fromMap(mapRejected, 'driver_123');
        expect(profileRejected.verificationStatus, equals('rejected'));
        expect(profileRejected.isRejectedVerification, isTrue);
        expect(profileRejected.rejectionReason, equals('ID expired'));
        expect(profileRejected.isApproved, isFalse);
      });

      test('legacy "verified" is rejected with FormatException', () {
        final mapVerified = Map<String, dynamic>.from(baseMap)..['verificationStatus'] = 'verified';
        expect(() => DriverProfile.fromMap(mapVerified, 'driver_123'), throwsFormatException);
      });

      test('empty, whitespace, or invalid strings in verificationStatus are rejected', () {
        for (final invalid in ['', '   ', 'APPROVED', ' Approved', 'pending ', 'in_review', 'submitted']) {
          final map = Map<String, dynamic>.from(baseMap)..['verificationStatus'] = invalid;
          expect(() => DriverProfile.fromMap(map, 'driver_123'), throwsFormatException, reason: 'Failed for $invalid');
        }
      });

      test('non-string verificationStatus types are rejected with FormatException', () {
        for (final invalid in [123, true, false, 1.5, ['approved'], {'status': 'approved'}]) {
          final map = Map<String, dynamic>.from(baseMap)..['verificationStatus'] = invalid;
          expect(() => DriverProfile.fromMap(map, 'driver_123'), throwsFormatException);
        }
      });

      test('valid verificationDocs parses cleanly', () {
        final now = DateTime.now();
        final mapWithDocs = Map<String, dynamic>.from(baseMap)
          ..['verificationStatus'] = 'pending'
          ..['verificationDocs'] = {
            'idPhotoUrl': 'https://firebasestorage.../id.jpg',
            'rcPhotoUrl': 'https://firebasestorage.../rc.jpg',
            'selfiePhotoUrl': 'https://firebasestorage.../selfie.jpg',
            'submittedAt': now,
          };
        final profile = DriverProfile.fromMap(mapWithDocs, 'driver_123');
        expect(profile.verificationDocs, isNotNull);
        expect(profile.verificationDocs!['idPhotoUrl'], equals('https://firebasestorage.../id.jpg'));
        expect(profile.verificationDocs!['submittedAt'], equals(now));
      });

      test('malformed verificationDocs fails closed with FormatException', () {
        // Non-map
        final nonMap = Map<String, dynamic>.from(baseMap)..['verificationDocs'] = 'not_a_map';
        expect(() => DriverProfile.fromMap(nonMap, 'driver_123'), throwsFormatException);

        // Missing idPhotoUrl
        final missingId = Map<String, dynamic>.from(baseMap)
          ..['verificationDocs'] = {
            'rcPhotoUrl': 'https://rc.jpg',
            'selfiePhotoUrl': 'https://selfie.jpg',
            'submittedAt': DateTime.now(),
          };
        expect(() => DriverProfile.fromMap(missingId, 'driver_123'), throwsFormatException);

        // Empty idPhotoUrl
        final emptyId = Map<String, dynamic>.from(baseMap)
          ..['verificationDocs'] = {
            'idPhotoUrl': '   ',
            'rcPhotoUrl': 'https://rc.jpg',
            'selfiePhotoUrl': 'https://selfie.jpg',
            'submittedAt': DateTime.now(),
          };
        expect(() => DriverProfile.fromMap(emptyId, 'driver_123'), throwsFormatException);

        // Non-string idPhotoUrl
        final intId = Map<String, dynamic>.from(baseMap)
          ..['verificationDocs'] = {
            'idPhotoUrl': 12345,
            'rcPhotoUrl': 'https://rc.jpg',
            'selfiePhotoUrl': 'https://selfie.jpg',
            'submittedAt': DateTime.now(),
          };
        expect(() => DriverProfile.fromMap(intId, 'driver_123'), throwsFormatException);

        // Missing submittedAt
        final missingSubmittedAt = Map<String, dynamic>.from(baseMap)
          ..['verificationDocs'] = {
            'idPhotoUrl': 'https://id.jpg',
            'rcPhotoUrl': 'https://rc.jpg',
            'selfiePhotoUrl': 'https://selfie.jpg',
          };
        expect(() => DriverProfile.fromMap(missingSubmittedAt, 'driver_123'), throwsFormatException);

        // Non-Timestamp submittedAt
        final invalidSubmittedAt = Map<String, dynamic>.from(baseMap)
          ..['verificationDocs'] = {
            'idPhotoUrl': 'https://id.jpg',
            'rcPhotoUrl': 'https://rc.jpg',
            'selfiePhotoUrl': 'https://selfie.jpg',
            'submittedAt': '2026-09-11',
          };
        expect(() => DriverProfile.fromMap(invalidSubmittedAt, 'driver_123'), throwsFormatException);
      });
    });
  });
}
