import { useState, useEffect, useRef } from "react";
import { useClerk } from "@clerk/react";
import { useGetCurrentProfile, useUpdateCurrentProfile, getGetCurrentProfileQueryKey, useListMyHandovers, getListMyHandoversQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { User as UserIcon, Settings, Calendar, Award, MapPin, Loader2, MessageCircle, Camera, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

export default function Dashboard() {
  const { data: profile, isLoading } = useGetCurrentProfile();
  const { user } = useClerk();
  const handoversQuery = useListMyHandovers({ query: { queryKey: getListMyHandoversQueryKey(), refetchInterval: 30000 } });
  const updateProfile = useUpdateCurrentProfile();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [homeBase, setHomeBase] = useState("");
  const [bio, setBio] = useState("");
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [removeExistingPhoto, setRemoveExistingPhoto] = useState(false);
  const [photoStatus, setPhotoStatus] = useState("");
  const [isPhotoPending, setIsPhotoPending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const needsName = !!profile && (!profile.displayName?.trim() || profile.displayName.trim().toLowerCase() === "traveller");

  useEffect(() => {
    if (profile) {
      setDisplayName(profile.displayName || "");
      setHomeBase(profile.homeBase || "");
      setBio(profile.bio || "");
    }
  }, [profile, isEditDialogOpen]);

  const resetStagedPhoto = () => {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoPreview(null);
    setPhotoFile(null);
    setRemoveExistingPhoto(false);
    setPhotoStatus("");
  };

  const handleSaveProfile = async () => {
    if (!displayName.trim()) {
      toast({ title: "Add your name", description: "Tell us what you would like to be called.", variant: "destructive" });
      return;
    }
    try {
      await updateProfile.mutateAsync({
        data: {
          displayName: displayName.trim(),
          homeBase: homeBase.trim() || null,
          bio: bio.trim() || null
        }
      });
      await queryClient.invalidateQueries({ queryKey: getGetCurrentProfileQueryKey() });
    } catch {
      toast({
        title: "Profile details not saved",
        description: "No photo changes were applied. Check your details and try again.",
        variant: "destructive"
      });
      return;
    }

    if ((photoFile || removeExistingPhoto) && user) {
      setIsPhotoPending(true);
      setPhotoStatus(photoFile ? "Uploading profile photo…" : "Removing profile photo…");
      try {
        await user.setProfileImage({ file: photoFile ?? null });
      } catch {
        setIsPhotoPending(false);
        setPhotoStatus(photoFile
          ? "Your profile details were saved, but the photo upload failed. Try another JPG, PNG, GIF, or WebP image under 10 MB."
          : "Your profile details were saved, but the photo could not be removed. Try again.");
        toast({
          title: "Profile details saved; photo unchanged",
          description: "Retry the photo change or close the editor. Your other profile details are safe.",
          variant: "destructive",
        });
        return;
      }
      setIsPhotoPending(false);
    }

    resetStagedPhoto();
    setIsEditDialogOpen(false);
    toast({
      title: "Profile updated",
      description: "Your profile details and photo changes have been saved.",
    });
  };

  const selectPhoto = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 10 * 1024 * 1024) {
      setPhotoStatus("Choose an image file under 10 MB.");
      return;
    }
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(file);
    setRemoveExistingPhoto(false);
    setPhotoPreview(URL.createObjectURL(file));
    setPhotoStatus("New photo selected. Save changes to upload it.");
  };

  const stagePhotoRemoval = () => {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(null);
    setPhotoPreview(null);
    setRemoveExistingPhoto(true);
    setPhotoStatus("Photo will be removed when you save changes.");
  };

  const handleDialogOpenChange = (open: boolean) => {
    if (needsName && !open) return;
    if (!open) resetStagedPhoto();
    setIsEditDialogOpen(open);
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="animate-spin text-primary"><UserIcon size={32} /></div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-4 md:p-8 max-w-6xl mx-auto w-full space-y-8 animate-fade-in-up">
      <div className="flex flex-col md:flex-row gap-6 justify-between items-start md:items-center">
        <div>
          <h1 className="text-3xl font-serif font-bold tracking-tight">{needsName ? "Welcome to your dashboard" : `${profile?.displayName}'s dashboard`}</h1>
          <p className="text-muted-foreground mt-2 text-lg">{needsName ? "Complete your profile so we know what to call you." : "Welcome back. Ready for your next journey?"}</p>
        </div>
        <Link href="/planner">
          <Button className="rounded-full shadow-lg font-bold px-8">Plan a Trip</Button>
        </Link>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        <Card className="md:col-span-2 bg-card/60 backdrop-blur-sm border-border/60 shadow-lg relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full blur-[60px] pointer-events-none -mt-10 -mr-10" />
          <CardHeader className="flex flex-row items-center gap-6 pb-6 border-b border-border/40">
            <Avatar className="w-20 h-20 border-4 border-background shadow-xl">
              <AvatarImage src={user?.imageUrl} alt={`${profile?.displayName || "Your"} profile photo`} />
              <AvatarFallback className="bg-primary/20 text-primary text-2xl font-serif font-bold">
                {needsName ? <UserIcon size={26} /> : profile?.displayName?.charAt(0)}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1">
              <CardTitle className="text-2xl font-serif mb-1">{needsName ? "Add your display name" : profile?.displayName}</CardTitle>
              <CardDescription className="text-base flex items-center gap-1.5 font-medium">
                <MapPin size={16} /> Home base: {profile?.homeBase || 'Not set'}
              </CardDescription>
            </div>
            <Dialog open={isEditDialogOpen || needsName} onOpenChange={handleDialogOpenChange}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2 rounded-full self-start shrink-0">
                  <Settings size={16} /> Edit profile
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                  <DialogTitle className="font-serif text-2xl">{needsName ? "What should we call you?" : "Edit profile"}</DialogTitle>
                  <DialogDescription>{needsName ? "Choose the name shown in your private account. You can change it at any time." : "Update the details used to personalize your private travel account."}</DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label>Profile photo</Label>
                    <div className="flex items-center gap-4 rounded-xl border border-border/60 p-3">
                      <Avatar className="h-16 w-16">
                        <AvatarImage src={removeExistingPhoto ? undefined : photoPreview || user?.imageUrl} alt="Profile photo preview" />
                        <AvatarFallback>{displayName.trim().charAt(0).toUpperCase() || <UserIcon size={20} />}</AvatarFallback>
                      </Avatar>
                      <div className="flex flex-wrap gap-2">
                        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="sr-only" onChange={(event) => selectPhoto(event.target.files?.[0])} />
                        <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => fileInputRef.current?.click()} disabled={isPhotoPending}>
                          <Camera size={15} /> {(user?.hasImage && !removeExistingPhoto) || photoFile ? "Replace" : "Upload"}
                        </Button>
                        {(user?.hasImage || photoFile) && !removeExistingPhoto && (
                          <Button type="button" variant="ghost" size="sm" className="gap-2 text-destructive" onClick={photoFile && !user?.hasImage ? () => { setPhotoFile(null); setPhotoPreview(null); setPhotoStatus("New photo cleared."); } : stagePhotoRemoval} disabled={isPhotoPending}>
                            <Trash2 size={15} /> Remove
                          </Button>
                        )}
                      </div>
                    </div>
                    <p role="status" aria-live="polite" className={`text-xs ${photoStatus.includes("failed") || photoStatus.startsWith("Choose") || photoStatus.startsWith("We could") ? "text-destructive" : "text-muted-foreground"}`}>{photoStatus || "JPG, PNG, GIF, or WebP. Maximum 10 MB."}</p>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="displayName">What should we call you?</Label>
                    <Input
                      id="displayName"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className="bg-background/50"
                      placeholder="Your display name"
                      autoFocus={needsName}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="homeBase">Home Base</Label>
                    <Input
                      id="homeBase"
                      value={homeBase}
                      onChange={(e) => setHomeBase(e.target.value)}
                      placeholder="e.g. London, UK"
                      className="bg-background/50"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="bio">Bio</Label>
                    <Textarea
                      id="bio"
                      value={bio}
                      onChange={(e) => setBio(e.target.value)}
                      placeholder="Share your travel style..."
                      className="bg-background/50 min-h-[100px]"
                    />
                  </div>
                </div>
                <DialogFooter>
                  {!needsName && <Button variant="outline" onClick={() => handleDialogOpenChange(false)}>Cancel</Button>}
                  <Button onClick={handleSaveProfile} disabled={updateProfile.isPending || isPhotoPending || !displayName.trim()}>
                    {(updateProfile.isPending || isPhotoPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {needsName ? "Continue to dashboard" : "Save changes"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent className="pt-6">
            <h4 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-3">Bio</h4>
            <p className="text-base leading-relaxed">
              {profile?.bio || 'You haven\'t added a bio yet. Share your travel style to get better recommendations.'}
            </p>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="bg-card border-border/50 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg font-serif flex items-center gap-2"><MessageCircle className="text-primary" size={20} /> Advisor support</CardTitle>
            </CardHeader>
            <CardContent>
              {handoversQuery.data?.length ? (
                <div className="space-y-3">
                  {handoversQuery.data.slice(0, 2).map((handover) => (
                    <div key={handover.handoverId} data-testid={`status-handover-${handover.handoverId}`} className="rounded-lg border border-border/50 p-3">
                      <div className="flex items-center justify-between gap-2"><span className="text-xs font-bold uppercase tracking-wider text-primary">{handover.status}</span><span className="text-[11px] text-muted-foreground">{new Date(handover.updatedAt).toLocaleDateString()}</span></div>
                      <p className="text-sm mt-1">{handover.travellerReply || "An advisor is reviewing your request."}</p>
                    </div>
                  ))}
                  <p className="text-[11px] text-muted-foreground">Requests are reviewed during staffed hours; typical response time is one business day.</p>
                </div>
              ) : <p className="text-sm text-muted-foreground">No advisor requests yet. You can request support from a saved plan.</p>}
            </CardContent>
          </Card>
          <Card className="bg-card border-border/50 shadow-sm hover:border-primary/30 transition-colors">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg font-serif flex items-center gap-2">
                <Calendar className="text-primary" size={20} /> My Trips
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">View your saved itineraries and manage active booking requests.</p>
              <Link href="/bookings">
                <Button variant="outline" className="w-full rounded-lg font-semibold bg-background">View Trips</Button>
              </Link>
            </CardContent>
          </Card>

          <Card className="bg-card border-border/50 shadow-sm hover:border-primary/30 transition-colors">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg font-serif flex items-center gap-2">
                <Award className="text-primary" size={20} /> Impact & Rewards
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">Track your sustainability points and climate contribution.</p>
              <Link href="/rewards">
                <Button variant="outline" className="w-full rounded-lg font-semibold bg-background">View Impact</Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
