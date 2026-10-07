import 'package:driver_app/core/models/driver_profile.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DriverProfile Wallet & Cancellation Policy Contract (Batch 2)', () {
    final baseValidMap = {
      'uid': 'driver_wallet_test_1',
      'name': 'Test Driver',
      'phone': '+919876543210',
      'verificationStatus': 'approved',
      'truckType': 'flatbed',
      'vehicleNumber': 'MH12AB1234',
      'isOnDuty': false,
      'walletBalance': 50000, // ₹500.00
      'monthlyCancelCount': {
        'month': '2026-10',
        'count': 1,
      },
      'strictMode': false,
    };

    test('parses valid safe integer walletBalance in paise', () {
      final profile = DriverProfile.fromMap(baseValidMap, 'driver_wallet_test_1');
      expect(profile.walletBalance, equals(50000));
      expect(profile.walletBalanceRupees, equals(500.0));
      expect(profile.formattedWalletBalance, equals('₹500.00'));
      expect(profile.isLowBalance, isFalse);
    });

    test('low balance threshold flags true when balance < ₹200 (20000 paise)', () {
      final lowBalanceMap = Map<String, dynamic>.from(baseValidMap);
      lowBalanceMap['walletBalance'] = 15000; // ₹150.00
      final profile = DriverProfile.fromMap(lowBalanceMap, 'driver_wallet_test_1');
      expect(profile.walletBalance, equals(15000));
      expect(profile.isLowBalance, isTrue);
      expect(profile.formattedWalletBalance, equals('₹150.00'));
    });

    test('zero wallet balance is valid non-negative integer', () {
      final zeroBalanceMap = Map<String, dynamic>.from(baseValidMap);
      zeroBalanceMap['walletBalance'] = 0;
      final profile = DriverProfile.fromMap(zeroBalanceMap, 'driver_wallet_test_1');
      expect(profile.walletBalance, equals(0));
      expect(profile.walletBalanceRupees, equals(0.0));
      expect(profile.isLowBalance, isTrue);
    });

    test('fails closed on malformed walletBalance (negative, double, string, object)', () {
      // Negative integer
      final negMap = Map<String, dynamic>.from(baseValidMap)..['walletBalance'] = -500;
      expect(() => DriverProfile.fromMap(negMap, 'driver_wallet_test_1'), throwsA(isA<FormatException>()));

      // Double value
      final doubleMap = Map<String, dynamic>.from(baseValidMap)..['walletBalance'] = 500.50;
      expect(() => DriverProfile.fromMap(doubleMap, 'driver_wallet_test_1'), throwsA(isA<FormatException>()));

      // String value
      final stringMap = Map<String, dynamic>.from(baseValidMap)..['walletBalance'] = '50000';
      expect(() => DriverProfile.fromMap(stringMap, 'driver_wallet_test_1'), throwsA(isA<FormatException>()));

      // Object / Map value
      final objMap = Map<String, dynamic>.from(baseValidMap)..['walletBalance'] = {'amount': 50000};
      expect(() => DriverProfile.fromMap(objMap, 'driver_wallet_test_1'), throwsA(isA<FormatException>()));

      // Explicit null value (F03)
      final nullMap = Map<String, dynamic>.from(baseValidMap)..['walletBalance'] = null;
      expect(() => DriverProfile.fromMap(nullMap, 'driver_wallet_test_1'), throwsA(isA<FormatException>()));

      // Exceeds JavaScript max safe integer (9007199254740992) (F03)
      final overflowMap = Map<String, dynamic>.from(baseValidMap)..['walletBalance'] = 9007199254740992;
      expect(() => DriverProfile.fromMap(overflowMap, 'driver_wallet_test_1'), throwsA(isA<FormatException>()));
    });

    test('parses monthlyCancelCount safely', () {
      final profile = DriverProfile.fromMap(baseValidMap, 'driver_wallet_test_1');
      expect(profile.monthlyCancelCount, isNotNull);
      expect(profile.monthlyCancelCount!.month, equals('2026-10'));
      expect(profile.monthlyCancelCount!.count, equals(1));

      // Missing or null defaults to null without throwing
      final nullCountMap = Map<String, dynamic>.from(baseValidMap)..remove('monthlyCancelCount');
      final nullProfile = DriverProfile.fromMap(nullCountMap, 'driver_wallet_test_1');
      expect(nullProfile.monthlyCancelCount, isNull);
    });

    test('parses strictMode safely (defaults to false if absent)', () {
      final profile = DriverProfile.fromMap(baseValidMap, 'driver_wallet_test_1');
      expect(profile.strictMode, isFalse);

      final strictMap = Map<String, dynamic>.from(baseValidMap)..['strictMode'] = true;
      final strictProfile = DriverProfile.fromMap(strictMap, 'driver_wallet_test_1');
      expect(strictProfile.strictMode, isTrue);

      final absentMap = Map<String, dynamic>.from(baseValidMap)..remove('strictMode');
      final absentProfile = DriverProfile.fromMap(absentMap, 'driver_wallet_test_1');
      expect(absentProfile.strictMode, isFalse);
    });

    test('NO hardcoded ₹200 duty authority: driver can be on duty with zero or low balance', () {
      // The driver profile model allows isOnDuty = true regardless of walletBalance
      final onDutyZeroBalanceMap = Map<String, dynamic>.from(baseValidMap)
        ..['walletBalance'] = 0
        ..['isOnDuty'] = true;
      final profile = DriverProfile.fromMap(onDutyZeroBalanceMap, 'driver_wallet_test_1');
      expect(profile.isOnDuty, isTrue);
      expect(profile.walletBalance, equals(0));
      expect(profile.isLowBalance, isTrue);
    });
  });
}
