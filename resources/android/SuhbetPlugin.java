package com.umit.mesaj;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Suhbet Edek'in kendi küçük eklentisi:
 *  - saveImage: fotoğrafı galeriye kaydeder (Resimler/Suhbet Edek)
 *  - showNotification: zil sesli bildirim gösterir
 *  - requestNotifyPermission: Android 13+ bildirim izni
 */
@CapacitorPlugin(
    name = "Suhbet",
    permissions = {
        @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class SuhbetPlugin extends Plugin {

    // Kısa titreşimli kanal (eski "mesajlar_zil" kanalı kaldırılır; Android kanal ayarlarını sonradan değiştirmez)
    private static final String CHANNEL_ID = "mesajlar_v2";
    private static final String OLD_CHANNEL_ID = "mesajlar_zil";
    private static final long[] SHORT_VIBRATION = { 0, 220 };
    private static final String FOLDER = "Suhbet Edek";
    private int nextNotificationId = 1000;

    // ---------------- Galeriye kaydet ----------------
    @PluginMethod
    public void saveImage(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storagePermissionDone");
            return;
        }
        writeImage(call);
    }

    @PermissionCallback
    private void storagePermissionDone(PluginCall call) {
        if (getPermissionState("storage") == PermissionState.GRANTED) {
            writeImage(call);
        } else {
            call.reject("Depolama izni verilmedi");
        }
    }

    private void writeImage(PluginCall call) {
        String data = call.getString("data");
        String name = call.getString("name");
        if (data == null || data.isEmpty()) {
            call.reject("Fotoğraf verisi yok");
            return;
        }
        if (name == null || name.isEmpty()) {
            name = "suhbet_" + System.currentTimeMillis() + ".jpg";
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            Context ctx = getContext();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + FOLDER);
                values.put(MediaStore.Images.Media.IS_PENDING, 1);
                Uri uri = ctx.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                if (uri == null) {
                    throw new Exception("Galeriye yazılamadı");
                }
                OutputStream out = ctx.getContentResolver().openOutputStream(uri);
                if (out == null) {
                    throw new Exception("Galeriye yazılamadı");
                }
                try {
                    out.write(bytes);
                } finally {
                    out.close();
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.Images.Media.IS_PENDING, 0);
                ctx.getContentResolver().update(uri, done, null, null);
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), FOLDER);
                if (!dir.exists() && !dir.mkdirs()) {
                    throw new Exception("Klasör oluşturulamadı");
                }
                File file = new File(dir, name);
                FileOutputStream out = new FileOutputStream(file);
                try {
                    out.write(bytes);
                } finally {
                    out.close();
                }
                MediaScannerConnection.scanFile(ctx, new String[] { file.getAbsolutePath() }, new String[] { "image/jpeg" }, null);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "Kaydedilemedi");
        }
    }

    // ---------------- Uygulama açıkken: zil + kısa titreşim ----------------
    /**
     * Mesaj geldiğinde (uygulama açıkken) telefonun zil ayarına göre uyarır:
     * zil açık → ses + titreşim, titreşim modu → yalnız titreşim, sessiz → hiçbiri.
     * Ses medya sesinden değil, bildirim sesinden çalar.
     */
    @PluginMethod
    public void alert(PluginCall call) {
        Context ctx = getContext();
        AudioManager audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        int mode = audio != null ? audio.getRingerMode() : AudioManager.RINGER_MODE_NORMAL;
        if (mode == AudioManager.RINGER_MODE_NORMAL) {
            try {
                Uri sound = Uri.parse("android.resource://" + ctx.getPackageName() + "/raw/chime");
                Ringtone tone = RingtoneManager.getRingtone(ctx, sound);
                if (tone != null) {
                    tone.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
                    tone.play();
                }
            } catch (Exception ignored) {
                // ses çalınamazsa titreşim yine olur
            }
        }
        if (mode != AudioManager.RINGER_MODE_SILENT) {
            vibrateShort(ctx);
        }
        JSObject result = new JSObject();
        result.put("sound", mode == AudioManager.RINGER_MODE_NORMAL);
        call.resolve(result);
    }

    @SuppressWarnings("deprecation")
    private void vibrateShort(Context ctx) {
        try {
            Vibrator vibrator = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator == null || !vibrator.hasVibrator()) {
                return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createOneShot(220, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                vibrator.vibrate(220);
            }
        } catch (Exception ignored) {
            // titreşim yoksa sessizce geç
        }
    }

    /** Bildirim kanalını hazırla (Firebase bildirimleri de bu kanalı kullanır) */
    @PluginMethod
    public void prepareChannel(PluginCall call) {
        Context ctx = getContext();
        ensureChannel(ctx, Uri.parse("android.resource://" + ctx.getPackageName() + "/raw/chime"));
        call.resolve();
    }

    // ---------------- Bildirim ----------------
    @PluginMethod
    public void requestNotifyPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("notifications", call, "notifyPermissionDone");
    }

    @PermissionCallback
    private void notifyPermissionDone(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(result);
    }

    @PluginMethod
    public void showNotification(PluginCall call) {
        String title = call.getString("title", "Suhbet Edek");
        String body = call.getString("body", "");
        Context ctx = getContext();
        Uri sound = Uri.parse("android.resource://" + ctx.getPackageName() + "/raw/chime");
        ensureChannel(ctx, sound);

        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        PendingIntent tap = null;
        if (open != null) {
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            tap = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }
        int icon = ctx.getResources().getIdentifier("ic_stat_suhbet", "drawable", ctx.getPackageName());
        if (icon == 0) {
            icon = ctx.getApplicationInfo().icon;
        }
        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(icon)
            .setColor(0xFF008069)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setSound(sound)
            .setVibrate(SHORT_VIBRATION)
            .setAutoCancel(true);
        if (tap != null) {
            builder.setContentIntent(tap);
        }
        try {
            NotificationManagerCompat.from(ctx).notify(nextNotificationId++, builder.build());
            call.resolve();
        } catch (SecurityException e) {
            call.reject("Bildirim izni yok");
        }
    }

    private void ensureChannel(Context ctx, Uri sound) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        if (manager.getNotificationChannel(OLD_CHANNEL_ID) != null) {
            manager.deleteNotificationChannel(OLD_CHANNEL_ID);
        }
        if (manager.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Mesajlar", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Yeni mesaj bildirimleri (zil sesi)");
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        channel.setSound(sound, attrs);
        channel.enableVibration(true);
        channel.setVibrationPattern(SHORT_VIBRATION);
        manager.createNotificationChannel(channel);
    }
}
