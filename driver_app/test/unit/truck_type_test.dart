import 'package:driver_app/core/models/truck_type.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('TruckType Enum', () {
    test('canonical backend values match exact backend schema', () {
      expect(TruckType.flatbed.backendValue, equals('flatbed'));
      expect(TruckType.tochan.backendValue, equals('tochan'));
      expect(TruckType.hydraulic.backendValue, equals('hydraulic'));
      expect(TruckType.crane.backendValue, equals('crane'));
    });

    test('TruckType.fromString parses valid strings case-insensitively', () {
      expect(TruckType.fromString('flatbed'), equals(TruckType.flatbed));
      expect(TruckType.fromString('FLATBED'), equals(TruckType.flatbed));
      expect(TruckType.fromString('tochan'), equals(TruckType.tochan));
      expect(TruckType.fromString('TOCHAN'), equals(TruckType.tochan));
      expect(TruckType.fromString('hydraulic'), equals(TruckType.hydraulic));
      expect(TruckType.fromString('Hydraulic'), equals(TruckType.hydraulic));
      expect(TruckType.fromString('crane'), equals(TruckType.crane));
      expect(TruckType.fromString('CRANE'), equals(TruckType.crane));
    });

    test('TruckType.fromString trims whitespace', () {
      expect(TruckType.fromString('  hydraulic  '), equals(TruckType.hydraulic));
      expect(TruckType.fromString('\ttochan\n'), equals(TruckType.tochan));
    });

    test('TruckType.fromString rejects null, blank, unknown, and wrong types without fallback to flatbed', () {
      expect(() => TruckType.fromString(null), throwsFormatException);
      expect(() => TruckType.fromString(''), throwsFormatException);
      expect(() => TruckType.fromString('   '), throwsFormatException);
      expect(() => TruckType.fromString('unknown_type'), throwsFormatException);
      expect(() => TruckType.fromString('rocket'), throwsFormatException);
    });

    test('TruckType.tryParse returns null for invalid values and non-strings', () {
      expect(TruckType.tryParse(null), isNull);
      expect(TruckType.tryParse(''), isNull);
      expect(TruckType.tryParse('   '), isNull);
      expect(TruckType.tryParse('invalid'), isNull);
      expect(TruckType.tryParse(123), isNull);
      expect(TruckType.tryParse(true), isNull);
      expect(TruckType.tryParse(['flatbed']), isNull);
    });

    test('TruckType.tryParse correctly parses valid types case-insensitively', () {
      expect(TruckType.tryParse('flatbed'), equals(TruckType.flatbed));
      expect(TruckType.tryParse('  TOCHAN  '), equals(TruckType.tochan));
      expect(TruckType.tryParse('Hydraulic'), equals(TruckType.hydraulic));
      expect(TruckType.tryParse('crane'), equals(TruckType.crane));
    });
  });
}
