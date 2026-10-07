import 'package:flutter/services.dart';

/// Service to launch external native turn-by-turn map navigation
/// (e.g. Google Maps or native geo intent handler) for pickup and destination coordinates.
class ExternalNavigationService {
  static const MethodChannel _channel =
      MethodChannel('com.towingapp.driver_app/external_navigation');

  /// Launches external map application to navigate to [lat], [lng] with optional [label].
  /// Returns `true` if an external activity successfully accepted the intent.
  static Future<bool> launchNavigation({
    required double lat,
    required double lng,
    String? label,
  }) async {
    try {
      final res = await _channel.invokeMethod<bool>('launchMap', {
        'lat': lat,
        'lng': lng,
        'label': label ?? 'Location',
      });
      return res ?? false;
    } catch (_) {
      return false;
    }
  }
}
