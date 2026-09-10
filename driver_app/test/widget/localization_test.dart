import 'dart:convert';
import 'dart:io';
import 'package:driver_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Trilingual Localization Tests (EN / HI / MR)', () {
    test('English translations load and match expected strings', () async {
      final l10n = await AppLocalizations.delegate.load(const Locale('en'));

      expect(l10n.appName, equals('Towing Driver'));
      expect(l10n.phoneNumber, equals('Phone Number'));
      expect(l10n.sendOtp, equals('Send OTP'));
      expect(l10n.enterOtp, equals('Enter 6-Digit OTP'));
      expect(l10n.verifyOtp, equals('Verify OTP'));
      expect(l10n.resendOtp, equals('Resend OTP'));
      expect(l10n.driverSetupComplete, equals('Driver app setup complete'));
      expect(l10n.statusOffDuty, equals('Off Duty'));
      expect(l10n.dutyStatus, equals('Duty Status'));
    });

    test('Hindi translations load and match expected strings', () async {
      final l10n = await AppLocalizations.delegate.load(const Locale('hi'));

      expect(l10n.appName, equals('टोइंग ड्राइवर'));
      expect(l10n.phoneNumber, equals('फ़ोन नंबर'));
      expect(l10n.sendOtp, equals('ओटीपी भेजें'));
      expect(l10n.enterOtp, equals('6-अंकों का ओटीपी दर्ज करें'));
      expect(l10n.verifyOtp, equals('ओटीपी सत्यापित करें'));
      expect(l10n.resendOtp, equals('ओटीपी पुनः भेजें'));
      expect(l10n.driverSetupComplete, equals('ड्राइवर ऐप सेटअप पूरा हुआ'));
      expect(l10n.statusOffDuty, equals('ड्यूटी बंद'));
      expect(l10n.dutyStatus, equals('ड्यूटी स्थिति'));
    });

    test('Marathi translations load and match expected strings', () async {
      final l10n = await AppLocalizations.delegate.load(const Locale('mr'));

      expect(l10n.appName, equals('टोईंग ड्रायव्हर'));
      expect(l10n.phoneNumber, equals('फोन नंबर'));
      expect(l10n.sendOtp, equals('ओटीपी पाठवा'));
      expect(l10n.enterOtp, equals('६-अंकी ओटीपी टाका'));
      expect(l10n.verifyOtp, equals('ओटीपी तपासा'));
      expect(l10n.resendOtp, equals('ओटीपी पुन्हा पाठवा'));
      expect(l10n.driverSetupComplete, equals('ड्रायव्हर ॲप सेटअप पूर्ण झाले'));
      expect(l10n.statusOffDuty, equals('ड्युटी बंद'));
      expect(l10n.dutyStatus, equals('ड्युटी स्थिती'));
    });

    test('exact key set equality across EN, HI, and MR ARB files', () {
      Set<String> extractKeys(String path) {
        final content = File(path).readAsStringSync();
        final json = jsonDecode(content) as Map<String, dynamic>;
        return json.keys.where((k) => !k.startsWith('@')).toSet();
      }

      final enKeys = extractKeys('lib/l10n/app_en.arb');
      final hiKeys = extractKeys('lib/l10n/app_hi.arb');
      final mrKeys = extractKeys('lib/l10n/app_mr.arb');

      expect(enKeys.length, equals(46));
      expect(hiKeys, equals(enKeys));
      expect(mrKeys, equals(enKeys));
    });
  });
}
