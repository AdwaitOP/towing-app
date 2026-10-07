import 'dart:typed_data';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart';

import '../../../core/config/app_config.dart';
import '../../../core/services/location_service.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../../../theme/app_typography.dart';

typedef MapWidgetBuilder = Widget Function(
  BuildContext context,
  DriverPosition? position,
);

/// Generates valid, decodeable PNG image bytes for the driver map marker.
Future<Uint8List> createDriverMarkerPng({int size = 48}) async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);

  // Outer primary blue circle
  final outerPaint = Paint()
    ..color = const Color(0xFF1976D2)
    ..style = PaintingStyle.fill;
  canvas.drawCircle(Offset(size / 2, size / 2), size / 2, outerPaint);

  // White inner ring
  final ringPaint = Paint()
    ..color = const Color(0xFFFFFFFF)
    ..style = PaintingStyle.stroke
    ..strokeWidth = size * 0.12;
  canvas.drawCircle(Offset(size / 2, size / 2), size * 0.38, ringPaint);

  // White center dot
  final dotPaint = Paint()
    ..color = const Color(0xFFFFFFFF)
    ..style = PaintingStyle.fill;
  canvas.drawCircle(Offset(size / 2, size / 2), size * 0.18, dotPaint);

  final picture = recorder.endRecording();
  final image = await picture.toImage(size, size);
  final byteData = await image.toByteData(format: ui.ImageByteFormat.png);
  return byteData!.buffer.asUint8List();
}

/// Driver map visualization widget powered by Mapbox.
///
/// Features a strict configuration boundary:
/// - If [AppConfig.mapboxPublicAccessToken] is missing or empty, renders a high-contrast
///   graceful fallback card displaying coordinates if available.
/// - Supports an injectable [mapWidgetBuilder] for deterministic headless unit/widget tests.
/// - Decoupled from tracking lifecycle: map disposal or pause does not mutate duty state.
class DriverMapView extends StatefulWidget {
  final DriverPosition? currentPosition;
  final String accessToken;
  final MapWidgetBuilder? mapWidgetBuilder;

  const DriverMapView({
    super.key,
    this.currentPosition,
    this.accessToken = AppConfig.mapboxPublicAccessToken,
    this.mapWidgetBuilder,
  });

  @override
  State<DriverMapView> createState() => _DriverMapViewState();
}

class _DriverMapViewState extends State<DriverMapView> {
  MapboxMap? _mapboxMap;
  PointAnnotationManager? _pointAnnotationManager;
  PointAnnotation? _driverAnnotation;
  Uint8List? _pinImageBytes;
  int _mapInstanceId = 0;
  int _positionUpdateSeq = 0;
  DriverPosition? _pendingPosition;
  bool _isDisposed = false;
  Future<void> _annotationQueue = Future.value();

  @override
  void initState() {
    super.initState();
    if (widget.accessToken.trim().isNotEmpty) {
      MapboxOptions.setAccessToken(widget.accessToken.trim());
    }
    _loadMarkerImage();
  }

  void _loadMarkerImage() async {
    final bytes = await createDriverMarkerPng();
    if (mounted && !_isDisposed) {
      setState(() {
        _pinImageBytes = bytes;
      });
      final pos = _pendingPosition ?? widget.currentPosition;
      if (pos != null &&
          _pointAnnotationManager != null &&
          _driverAnnotation == null) {
        _updateDriverPin(pos);
      }
    }
  }

  @override
  void didUpdateWidget(DriverMapView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.currentPosition != oldWidget.currentPosition &&
        widget.currentPosition != null) {
      _updateDriverPin(widget.currentPosition!);
    }
  }

  void _onMapCreated(MapboxMap mapboxMap) async {
    final mapInstance = ++_mapInstanceId;
    final oldManager = _pointAnnotationManager;
    final oldAnn = _driverAnnotation;
    if (oldManager != null && oldAnn != null) {
      try {
        await oldManager.delete(oldAnn);
      } catch (_) {}
    }
    _driverAnnotation = null;
    _pointAnnotationManager = null;
    _mapboxMap = mapboxMap;
    if (widget.currentPosition != null) {
      _pendingPosition = widget.currentPosition;
    }
    try {
      final manager =
          await mapboxMap.annotations.createPointAnnotationManager();
      if (_isDisposed || mapInstance != _mapInstanceId) return;
      _pointAnnotationManager = manager;
      final pos = _pendingPosition ?? widget.currentPosition;
      if (pos != null) {
        _updateDriverPin(pos);
      }
    } catch (_) {
      // Graceful ignore if annotations manager unavailable
    }
  }

  void _updateDriverPin(DriverPosition position) {
    _pendingPosition = position;
    if (_isDisposed || _mapboxMap == null) return;

    final mapInstance = _mapInstanceId;
    final seq = ++_positionUpdateSeq;
    final cameraOptions = CameraOptions(
      center: Point(
        coordinates: Position(position.longitude, position.latitude),
      ),
      zoom: 15.0,
    );
    _mapboxMap?.setCamera(cameraOptions);

    final manager = _pointAnnotationManager;
    final pinBytes = _pinImageBytes;
    if (manager == null || pinBytes == null) return;

    _annotationQueue = _annotationQueue.then((_) async {
      if (_isDisposed || mapInstance != _mapInstanceId || seq != _positionUpdateSeq) return;

      try {
        if (_driverAnnotation != null) {
          _driverAnnotation!.geometry = Point(
            coordinates: Position(position.longitude, position.latitude),
          );
          await manager.update(_driverAnnotation!);
        } else {
          final created = await manager.create(
            PointAnnotationOptions(
              geometry: Point(
                coordinates: Position(position.longitude, position.latitude),
              ),
              image: pinBytes,
              iconSize: 1.0,
            ),
          );
          if (_isDisposed || mapInstance != _mapInstanceId) {
            await manager.delete(created);
          } else {
            _driverAnnotation = created;
          }
        }
      } catch (_) {}
    }).catchError((_) {});
  }

  @override
  void dispose() {
    _isDisposed = true;
    _mapInstanceId++;
    final manager = _pointAnnotationManager;
    final ann = _driverAnnotation;
    if (manager != null && ann != null) {
      try {
        manager.delete(ann);
      } catch (_) {}
    }
    _driverAnnotation = null;
    _pointAnnotationManager = null;
    _mapboxMap = null;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    // 1. Injectable builder override for tests
    if (widget.mapWidgetBuilder != null) {
      return widget.mapWidgetBuilder!(context, widget.currentPosition);
    }

    // 2. Fallback when Mapbox token is not configured (Adaptive natural height)
    if (widget.accessToken.trim().isEmpty) {
      return Container(
        key: const ValueKey('map_fallback_container'),
        constraints: const BoxConstraints(minHeight: 180.0),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(AppColors.borderRadius),
          border: Border.all(color: AppColors.border),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 20.0),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            const Icon(
              Icons.map_outlined,
              size: 44.0,
              color: AppColors.primary,
            ),
            const SizedBox(height: 10.0),
            Text(
              l10n.mapUnavailable,
              style: AppTypography.titleLarge.copyWith(
                color: AppColors.onBackground,
                fontWeight: FontWeight.bold,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 6.0),
            Text(
              l10n.mapTokenMissing,
              style: AppTypography.bodyMedium.copyWith(
                color: AppColors.textSecondary,
              ),
              textAlign: TextAlign.center,
            ),
            if (widget.currentPosition != null) ...[
              const SizedBox(height: 12.0),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12.0, vertical: 6.0),
                decoration: BoxDecoration(
                  color: AppColors.surfaceVariant,
                  borderRadius: BorderRadius.circular(8.0),
                  border: Border.all(color: AppColors.border),
                ),
                child: Text(
                  '${widget.currentPosition!.latitude.toStringAsFixed(5)}, ${widget.currentPosition!.longitude.toStringAsFixed(5)}',
                  style: AppTypography.bodyMedium.copyWith(
                    color: AppColors.primary,
                    fontWeight: FontWeight.w600,
                  ),
                  textAlign: TextAlign.center,
                ),
              ),
            ],
          ],
        ),
      );
    }

    // 3. Live Mapbox Map
    final initialCamera = widget.currentPosition != null
        ? CameraOptions(
            center: Point(
              coordinates: Position(
                widget.currentPosition!.longitude,
                widget.currentPosition!.latitude,
              ),
            ),
            zoom: 14.0,
          )
        : CameraOptions(
            center: Point(coordinates: Position(72.8777, 19.0760)), // Mumbai default
            zoom: 11.0,
          );

    return ClipRRect(
      borderRadius: BorderRadius.circular(AppColors.borderRadius),
      child: SizedBox(
        key: const ValueKey('mapbox_map_view'),
        height: 260.0,
        child: MapWidget(
          key: const ValueKey('mapbox_map_widget'),
          // ignore: deprecated_member_use
          cameraOptions: initialCamera,
          onMapCreated: _onMapCreated,
        ),
      ),
    );
  }
}
