import { useState } from "react";
import { useListSavedTrips, useListBookings, useCreateBooking, useUpdateSavedTrip, getListBookingsQueryKey, getListSavedTripsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Calendar, MapPin, Users, Wallet, ArrowRight, Clock, CheckCircle, XCircle, Trash2, Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";

export default function Bookings() {
  const { data: trips, isLoading: tripsLoading } = useListSavedTrips();
  const { data: bookings, isLoading: bookingsLoading } = useListBookings();
  const createBooking = useCreateBooking();
  const updateTrip = useUpdateSavedTrip();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [activeTab, setActiveTab] = useState("trips");

  const handleRequestBooking = (trip: any) => {
    createBooking.mutate({
      data: {
        tripId: trip.id,
        label: `${trip.title} (Test Request)`,
        bookingType: 'stay',
        providerReference: `DEMO-${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
        carbonKg: 240, // Demo value
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() });
        toast({
          title: "Test Booking Request Saved",
          description: "This is a request record only. No payment or live booking was completed."
        });
        setActiveTab("bookings");
      },
      onError: () => {
        toast({
          title: "Request failed",
          description: "Could not request the booking.",
          variant: "destructive"
        });
      }
    });
  };

  const handleToggleArchive = (trip: any) => {
    const isArchived = trip.status === 'archived';
    const newStatus = isArchived ? 'planning' : 'archived';
    
    updateTrip.mutate({
      id: trip.id,
      data: {
        title: trip.title,
        status: newStatus
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSavedTripsQueryKey() });
        toast({
          title: isArchived ? "Trip Restored" : "Trip Archived",
          description: `The itinerary has been ${isArchived ? 'restored' : 'archived'}.`
        });
      }
    });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'confirmed': case 'ready': return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      case 'requested': case 'planning': return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
      case 'cancelled': case 'archived': return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
      case 'demo': return 'bg-primary/10 text-primary border-primary/20';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'confirmed': case 'ready': return <CheckCircle size={14} className="mr-1" />;
      case 'requested': case 'planning': return <Clock size={14} className="mr-1" />;
      case 'cancelled': case 'archived': return <XCircle size={14} className="mr-1" />;
      default: return null;
    }
  };

  if (tripsLoading || bookingsLoading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="animate-spin text-primary"><MapPin size={32} /></div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-4 md:p-8 max-w-6xl mx-auto w-full space-y-8 animate-fade-in-up">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-serif font-bold tracking-tight">My Trips</h1>
          <p className="text-muted-foreground mt-2 text-lg">Resume saved plans and track test booking requests. No payment or live booking is completed here.</p>
        </div>
        <Link href="/planner">
          <Button className="rounded-full shadow-lg hover:shadow-primary/20 transition-all font-bold px-6">
            New Plan <ArrowRight size={16} className="ml-2" />
          </Button>
        </Link>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="bg-card border border-border/50 h-12 rounded-xl p-1 shadow-sm mb-6">
          <TabsTrigger value="trips" className="rounded-lg font-semibold text-sm">Saved Itineraries ({trips?.length || 0})</TabsTrigger>
          <TabsTrigger value="bookings" className="rounded-lg font-semibold text-sm">Booking Requests ({bookings?.length || 0})</TabsTrigger>
        </TabsList>
        
        <TabsContent value="trips" className="mt-0">
          <div className="grid md:grid-cols-2 gap-6">
            {trips?.map((trip) => (
              <Card key={trip.id} className="bg-card/50 backdrop-blur-sm border-border/60 hover:border-primary/40 transition-colors shadow-md">
                <CardHeader className="pb-4">
                  <div className="flex justify-between items-start">
                    <CardTitle className="text-xl font-serif leading-tight">{trip.title}</CardTitle>
                    <Badge variant="outline" className={`font-bold uppercase tracking-wider text-[10px] px-2.5 py-0.5 rounded-md ${getStatusColor(trip.status)}`}>
                      {getStatusIcon(trip.status)} {trip.status}
                    </Badge>
                  </div>
                  <CardDescription className="text-sm font-medium flex items-center gap-1.5 mt-2">
                    <MapPin size={14} className="text-primary"/> {trip.origin || 'Any'} → {trip.destination || 'TBD'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="pb-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Calendar size={16} /> <span className="font-medium">{trip.dateRange || 'Dates pending'}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Users size={16} /> <span className="font-medium">{trip.travellerCount ? `${trip.travellerCount} travellers` : 'TBD'}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Wallet size={16} /> <span className="font-medium">{trip.budget || 'Budget open'}</span>
                    </div>
                  </div>
                </CardContent>
                <CardFooter className="pt-4 border-t border-border/40 flex justify-between gap-2 flex-wrap">
                  <Button variant="ghost" size="sm" className="rounded-lg text-muted-foreground hover:text-foreground" onClick={() => handleToggleArchive(trip)} disabled={updateTrip.isPending}>
                    {updateTrip.isPending ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} className="mr-2" />}
                    {trip.status === 'archived' ? 'Restore' : 'Archive'}
                  </Button>
                  <Link href={`/planner?trip=${trip.id}`}>
                    <Button variant="outline" size="sm" className="rounded-lg font-semibold bg-background">
                      Resume plan <ArrowRight size={14} className="ml-2" />
                    </Button>
                  </Link>
                   <Button variant="outline" size="sm" className="rounded-lg font-semibold bg-background" onClick={() => handleRequestBooking(trip)} disabled={createBooking.isPending || trip.status === 'archived'}>
                    {createBooking.isPending ? <Loader2 size={16} className="animate-spin mr-2" /> : <Send size={16} className="mr-2" />}
                     Test booking request
                  </Button>
                </CardFooter>
              </Card>
            ))}
            {(!trips || trips.length === 0) && (
              <div className="col-span-full p-12 text-center bg-card/30 border border-dashed border-border rounded-3xl">
                <MapPin size={48} className="mx-auto mb-4 text-muted" />
                <h3 className="text-xl font-serif font-bold mb-2">No saved trips yet</h3>
                <p className="text-muted-foreground mb-6">Start planning to see your itineraries here.</p>
                <Link href="/planner">
                  <Button variant="outline" className="rounded-full">Start Planning</Button>
                </Link>
              </div>
            )}
          </div>
        </TabsContent>
        
        <TabsContent value="bookings" className="mt-0">
          <div className="space-y-4">
            {bookings?.map((booking) => (
              <div key={booking.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-5 rounded-2xl bg-card border border-border/50 hover:border-primary/30 transition-colors shadow-sm gap-4">
                <div className="flex items-start sm:items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-background border border-border/50 flex items-center justify-center text-primary shrink-0 shadow-inner">
                    <Calendar size={20} />
                  </div>
                  <div>
                    <h4 className="font-bold text-foreground text-lg">{booking.label}</h4>
                    <p className="text-sm text-muted-foreground font-medium mt-1 uppercase tracking-wider text-[11px]">
                      Type: {booking.bookingType} • Ref: {booking.providerReference || 'Pending'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4 justify-between sm:justify-end w-full sm:w-auto border-t sm:border-0 border-border/50 pt-4 sm:pt-0">
                  {booking.carbonKg !== null && (
                    <span className="text-xs font-bold text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-md border border-emerald-500/20">
                      {booking.carbonKg}kg CO₂e
                    </span>
                  )}
                  <Badge variant="outline" className={`font-bold uppercase tracking-wider text-[10px] px-3 py-1 rounded-md ${getStatusColor(booking.status)}`}>
                    {getStatusIcon(booking.status)} {booking.status}
                  </Badge>
                </div>
              </div>
            ))}
            {(!bookings || bookings.length === 0) && (
              <div className="p-12 text-center bg-card/30 border border-dashed border-border rounded-3xl">
                <Calendar size={48} className="mx-auto mb-4 text-muted" />
                <h3 className="text-xl font-serif font-bold mb-2">No booking records</h3>
                <p className="text-muted-foreground">When you request a booking, it will appear here.</p>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
