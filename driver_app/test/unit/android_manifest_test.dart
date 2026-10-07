import 'dart:io';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('AndroidManifest.xml Stage 3 Configuration Tests', () {
    late String manifestContent;

    setUpAll(() {
      final file = File('android/app/src/main/AndroidManifest.xml');
      expect(file.existsSync(), isTrue, reason: 'AndroidManifest.xml must exist');
      manifestContent = file.readAsStringSync();
    });

    test('declares ACCESS_FINE_LOCATION permission', () {
      expect(
        manifestContent.contains('android.permission.ACCESS_FINE_LOCATION'),
        isTrue,
      );
    });

    test('declares ACCESS_COARSE_LOCATION permission', () {
      expect(
        manifestContent.contains('android.permission.ACCESS_COARSE_LOCATION'),
        isTrue,
      );
    });

    test('declares ACCESS_BACKGROUND_LOCATION permission', () {
      expect(
        manifestContent.contains('android.permission.ACCESS_BACKGROUND_LOCATION'),
        isTrue,
      );
    });

    test('declares FOREGROUND_SERVICE permission', () {
      expect(
        manifestContent.contains('android.permission.FOREGROUND_SERVICE'),
        isTrue,
      );
    });

    test('declares FOREGROUND_SERVICE_LOCATION permission', () {
      expect(
        manifestContent.contains('android.permission.FOREGROUND_SERVICE_LOCATION'),
        isTrue,
      );
    });

    test('declares POST_NOTIFICATIONS permission', () {
      expect(
        manifestContent.contains('android.permission.POST_NOTIFICATIONS'),
        isTrue,
      );
    });

    test('declares flutter_foreground_task ForegroundService with location serviceType', () {
      expect(
        manifestContent.contains('com.pravera.flutter_foreground_task.service.ForegroundService'),
        isTrue,
      );
      expect(
        manifestContent.contains('android:foregroundServiceType="location"'),
        isTrue,
      );
    });
  });
}
